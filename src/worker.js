import { DurableObject } from 'cloudflare:workers';
import { friendlyError } from '../lib/avito.js';
import {
  acceptWebhook,
  dismissNotifications,
  forget,
  loadMessages,
  notifyCurrentUnread,
  pollOnce,
  pushTestNotification,
  registerWebhook,
  removeWebhook,
  saveSettings,
} from '../lib/monitor.js';
import { mergeState, toPublic } from '../lib/state.js';
import pkg from '../package.json' with { type: 'json' };

const PERMANENT = new Set([400, 401, 402, 403]);

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

function randomToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  if (text.length > 1_000_000) throw Object.assign(new Error('Слишком большой запрос.'), { status: 413 });
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Некорректный JSON.'), { status: 400 });
  }
}

function hasKeys(state) {
  return Boolean(state.settings.clientId && state.settings.clientSecret);
}

function runtimeFor(state) {
  return {
    running: hasKeys(state) && !state.paused,
    polling: false,
    nextPollAt: state.nextPollAt || null,
  };
}

export class AppState extends DurableObject {
  async withStore(fn) {
    const loaded = await this.ctx.storage.get('state');
    const state = mergeState(loaded);
    let dirty = !loaded;
    if (!state.settings.webhookToken) {
      state.settings.webhookToken = randomToken();
      dirty = true;
    }
    const store = {
      get() {
        return state;
      },
      update(mutator) {
        mutator(state);
        dirty = true;
      },
      replace(next) {
        const merged = mergeState(next);
        if (!merged.settings.webhookToken) merged.settings.webhookToken = randomToken();
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, merged);
        dirty = true;
      },
    };
    try {
      return await fn(store);
    } finally {
      if (dirty) await this.ctx.storage.put('state', state);
    }
  }

  async ensureAlarm(store) {
    const state = store.get();
    if (!hasKeys(state) || state.paused) {
      if (state.nextPollAt) store.update((current) => { current.nextPollAt = null; });
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const existing = await this.ctx.storage.getAlarm();
    if (existing) return;
    const delay = Math.max(15, Number(state.settings.pollSeconds) || 30) * 1000;
    const nextPollAt = Date.now() + delay;
    store.update((current) => { current.nextPollAt = nextPollAt; });
    await this.ctx.storage.setAlarm(nextPollAt);
  }

  async schedule(store, result) {
    const state = store.get();
    const permanent = result && PERMANENT.has(result.status);
    if (!hasKeys(state) || state.paused || permanent) {
      store.update((current) => { current.nextPollAt = null; });
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const delay = Math.max(15, Number(state.settings.pollSeconds) || 30) * 1000;
    const nextPollAt = Date.now() + delay;
    store.update((current) => { current.nextPollAt = nextPollAt; });
    await this.ctx.storage.setAlarm(nextPollAt);
  }

  async alarm() {
    let follow = null;
    try {
      await this.withStore(async (store) => {
        if (!hasKeys(store.get()) || store.get().paused) {
          await this.schedule(store, { status: 400 });
          return;
        }
        const result = await pollOnce(store);
        await this.schedule(store, result);
        follow = result;
      });
    } catch (error) {
      console.error(friendlyError(error));
      await this.withStore(async (store) => {
        await this.schedule(store, { status: 0 });
      });
    }
    return follow;
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      return await this.route(request, url);
    } catch (error) {
      return json({ error: friendlyError(error) }, error.status || 500);
    }
  }

  async route(request, url) {
    if (request.method === 'GET' && url.pathname === '/api/state') {
      return this.withStore(async (store) => {
        await this.ensureAlarm(store);
        return json(toPublic(store.get(), runtimeFor(store.get())));
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/events') {
      return this.withStore(async (store) => {
        await this.ensureAlarm(store);
        const payload = `retry: 15000\nevent: state\ndata: ${JSON.stringify(toPublic(store.get(), runtimeFor(store.get())))}\n\n`;
        return new Response(payload, {
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
          },
        });
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/settings') {
      const body = await readJson(request);
      return this.withStore(async (store) => {
        saveSettings(store, body);
        if (!body.connect) {
          await this.ensureAlarm(store);
          return json({ state: toPublic(store.get(), runtimeFor(store.get())) });
        }
        const settings = store.get().settings;
        if (!settings.clientId || !settings.clientSecret) {
          return json({
            error: 'Нужны Client ID и Client Secret из кабинета Авито.',
            state: toPublic(store.get(), runtimeFor(store.get())),
          }, 400);
        }
        store.update((state) => {
          state.paused = false;
        });
        const result = await pollOnce(store);
        await this.schedule(store, result);
        return json({
          error: result.error || null,
          state: toPublic(store.get(), runtimeFor(store.get())),
        }, result.ok ? 200 : result.status || 502);
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/poll') {
      return this.withStore(async (store) => {
        store.update((state) => {
          state.paused = false;
        });
        const result = await pollOnce(store);
        await this.schedule(store, result);
        return json({
          error: result.error || null,
          state: toPublic(store.get(), runtimeFor(store.get())),
        }, result.ok ? 200 : result.status || 502);
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/stop') {
      return this.withStore(async (store) => {
        store.update((state) => {
          state.paused = true;
        });
        await this.schedule(store, { status: 400 });
        return json({ state: toPublic(store.get(), runtimeFor(store.get())) });
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/forget') {
      return this.withStore(async (store) => {
        forget(store);
        await this.schedule(store, { status: 400 });
        return json({ state: toPublic(store.get(), runtimeFor(store.get())) });
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/test-notification') {
      return this.withStore(async (store) => {
        pushTestNotification(store);
        return json({ state: toPublic(store.get(), runtimeFor(store.get())) });
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/notifications/unread') {
      return this.withStore(async (store) => {
        notifyCurrentUnread(store);
        return json({ state: toPublic(store.get(), runtimeFor(store.get())) });
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/notifications/dismiss') {
      const body = await readJson(request);
      return this.withStore(async (store) => {
        dismissNotifications(store, { ids: body.ids, all: Boolean(body.all) });
        return json({ state: toPublic(store.get(), runtimeFor(store.get())) });
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/messages') {
      const chatId = url.searchParams.get('chatId');
      if (!chatId) return json({ error: 'Не указан чат.' }, 400);
      return this.withStore(async (store) => {
        const messages = await loadMessages(store, chatId);
        return json({ messages });
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/webhook/register') {
      const body = await readJson(request);
      return this.withStore(async (store) => {
        if (typeof body.publicWebhookUrl === 'string') saveSettings(store, { publicWebhookUrl: body.publicWebhookUrl });
        const webhookUrl = await registerWebhook(store);
        return json({ webhookUrl, state: toPublic(store.get(), runtimeFor(store.get())) });
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/webhook/unsubscribe') {
      return this.withStore(async (store) => {
        await removeWebhook(store);
        return json({ state: toPublic(store.get(), runtimeFor(store.get())) });
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/webhook') {
      const token = url.searchParams.get('token') || '';
      let accepted = false;
      await this.withStore(async (store) => {
        const expected = store.get().settings.webhookToken;
        if (!token || token.length !== expected.length) return;
        let diff = 0;
        for (let index = 0; index < token.length; index += 1) diff |= token.charCodeAt(index) ^ expected.charCodeAt(index);
        if (diff !== 0) return;
        accepted = true;
        try {
          acceptWebhook(store, await readJson(request));
        } catch (error) {
          console.error(`Webhook не разобран: ${friendlyError(error)}`);
        }
      });
      if (!accepted) return json({ ok: false }, 401);
      return json({ ok: true });
    }

    return json({ error: 'Не найдено.' }, 404);
  }
}

async function passwordToken(password) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`сводка:${password}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function cookieToken(request) {
  const header = request.headers.get('cookie') || '';
  const pair = header.split(';').map((part) => part.trim()).find((part) => part.startsWith('app_session='));
  return pair ? pair.slice('app_session='.length) : '';
}

async function authorized(request, env) {
  if (!env.APP_PASSWORD) return true;
  const expected = await passwordToken(env.APP_PASSWORD);
  const given = cookieToken(request);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < given.length; index += 1) diff |= given.charCodeAt(index) ^ expected.charCodeAt(index);
  return diff === 0;
}

async function serveAsset(request, env) {
  const asset = await env.ASSETS.fetch(request);
  const type = asset.headers.get('content-type') || '';
  if (!type.includes('text/html')) return asset;
  const html = (await asset.text()).replaceAll('__APP_VERSION__', pkg.version);
  return new Response(html, {
    status: asset.status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      return json({ error: friendlyError(error) }, error.status || 500);
    }
  },
};

async function handleRequest(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') return json({ ok: true });

    if (url.pathname === '/api/login' && request.method === 'POST') {
      if (!env.APP_PASSWORD) return json({ ok: true });
      const body = await readJson(request);
      if (body.password !== env.APP_PASSWORD) return json({ error: 'Неверный пароль.', locked: true }, 401);
      const token = await passwordToken(env.APP_PASSWORD);
      const secure = url.protocol === 'https:' ? '; Secure' : '';
      return json({ ok: true }, 200, {
        'set-cookie': `app_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${secure}`,
      });
    }

    if (url.pathname.startsWith('/api/')) {
      if (url.pathname !== '/api/webhook' && !(await authorized(request, env))) {
        return json({ error: 'Нужен пароль приложения.', locked: true }, 401);
      }
      const stub = env.APP.get(env.APP.idFromName('solo'));
      return stub.fetch(request);
    }

    return serveAsset(request, env);
}
