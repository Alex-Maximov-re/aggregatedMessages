import {
  composeWebhookUrl,
  fetchChats,
  fetchMessages,
  fetchProfile,
  fetchToken,
  friendlyError,
  mergeChatLists,
  normalizeChatList,
  normalizeMessages,
  parseWebhook,
  subscribeWebhook,
  unsubscribeWebhook,
} from './avito.js';
import { ingestChats, ingestWebhook } from './ingest.js';
import { applySettings, blankState } from './store.js';

let cache = { key: '', token: '', expiresAt: 0 };
let timer = null;
let stopped = true;
let running = false;
let polling = false;
let nextPollAt = null;
let backoffUntil = 0;
let storeRef = null;
let broadcastRef = () => {};
let chain = Promise.resolve();

export function getRuntime() {
  return { running, polling, nextPollAt };
}

export function clearToken() {
  cache = { key: '', token: '', expiresAt: 0 };
}

async function getToken(settings) {
  const key = `${settings.clientId}:${settings.clientSecret}`;
  if (cache.key === key && cache.token && cache.expiresAt > Date.now()) return cache.token;
  const got = await fetchToken(settings.clientId, settings.clientSecret);
  cache = { key, token: got.accessToken, expiresAt: got.expiresAt };
  return cache.token;
}

async function withToken(settings, fn) {
  try {
    return await fn(await getToken(settings));
  } catch (error) {
    if (error.status !== 401) throw error;
    clearToken();
    return fn(await getToken(settings));
  }
}

function delayMs(settings) {
  const base = Math.min(300, Math.max(15, Number(settings?.pollSeconds) || 30)) * 1000;
  if (Date.now() < backoffUntil) return Math.max(base, 120_000);
  return base;
}

function requireKeys(settings) {
  if (!settings.clientId || !settings.clientSecret) {
    throw Object.assign(new Error('Нужны Client ID и Client Secret из кабинета Авито.'), { status: 400 });
  }
}

export function saveSettings(store, input) {
  let keysChanged = false;
  store.update((state) => {
    const applied = applySettings(state, input || {});
    keysChanged = applied.keysChanged;
    state.settings = applied.settings;
    if (keysChanged) {
      state.profile = null;
      state.primed = false;
      state.seenIds = [];
      state.chats = [];
      state.notifications = [];
      state.lastError = null;
      state.lastPollAt = null;
      state.settings.webhookRegisteredUrl = '';
    }
  });
  if (keysChanged) clearToken();
  return keysChanged;
}

export function pollOnce(store) {
  const run = chain.then(() => pollOnceBody(store));
  chain = run.then(() => undefined, () => undefined);
  return run;
}

async function pollOnceBody(store) {
  const { settings } = store.get();
  try {
    requireKeys(settings);
    const snapshot = await withToken(settings, async (token) => {
      const profile = await fetchProfile(token);
      const recentPayload = await fetchChats(token, profile.id, { limit: 40 });
      let unreadPayload = { chats: [] };
      try {
        unreadPayload = await fetchChats(token, profile.id, { limit: 50, unreadOnly: true });
      } catch (error) {
        if (error.status === 401 || error.status === 402 || error.status === 403) throw error;
      }
      const chats = mergeChatLists(
        normalizeChatList(unreadPayload, profile.id),
        normalizeChatList(recentPayload, profile.id),
      );
      return { profile, chats };
    });

    store.update((state) => {
      const result = ingestChats(state, snapshot.chats, { notifyExisting: state.settings.notifyExisting });
      state.profile = { id: snapshot.profile.id, name: snapshot.profile.name || '' };
      state.chats = snapshot.chats;
      state.seenIds = result.seenIds;
      state.primed = result.primed;
      state.notifications = result.notifications;
      state.lastError = null;
      state.lastPollAt = Date.now();
    });
    return { ok: true };
  } catch (error) {
    if (error.status === 429) backoffUntil = Date.now() + 120_000;
    const message = friendlyError(error);
    store.update((state) => {
      state.lastError = message;
    });
    return { ok: false, error: message, status: error.status || 0 };
  }
}

export async function loadMessages(store, chatId) {
  const state = store.get();
  requireKeys(state.settings);
  if (!state.profile?.id) {
    const result = await pollOnce(store);
    if (!result.ok) throw Object.assign(new Error(result.error), { status: 502 });
  }
  const current = store.get();
  const payload = await withToken(current.settings, (token) => fetchMessages(token, current.profile.id, chatId));
  return normalizeMessages(payload, current.profile.id);
}

function schedule(ms) {
  clearTimeout(timer);
  if (stopped) return;
  nextPollAt = Date.now() + ms;
  timer = setTimeout(() => {
    tick().catch(() => {});
  }, ms);
}

async function tick() {
  if (stopped || !storeRef) return;
  polling = true;
  broadcastRef();
  let result = null;
  try {
    result = await pollOnce(storeRef);
  } finally {
    polling = false;
    const permanent = [400, 401, 402, 403].includes(result?.status);
    if (permanent) {
      stopped = true;
      running = false;
      nextPollAt = null;
      clearTimeout(timer);
    } else if (!stopped) schedule(delayMs(storeRef.get().settings));
    else nextPollAt = null;
    broadcastRef();
  }
}

export function start(store, broadcast, { immediate = true } = {}) {
  storeRef = store;
  broadcastRef = broadcast;
  clearTimeout(timer);
  stopped = false;
  running = true;
  schedule(immediate ? 0 : delayMs(store.get().settings));
  broadcast();
}

export function stop() {
  stopped = true;
  running = false;
  polling = false;
  nextPollAt = null;
  clearTimeout(timer);
}

export function reschedule() {
  if (!running || stopped || !storeRef) return;
  schedule(delayMs(storeRef.get().settings));
  broadcastRef();
}

export async function registerWebhook(store) {
  const state = store.get();
  requireKeys(state.settings);
  let url = '';
  try {
    url = composeWebhookUrl(state.settings.publicWebhookUrl, state.settings.webhookToken);
  } catch (error) {
    throw Object.assign(error, { status: 400 });
  }
  if (!url) throw Object.assign(new Error('Укажите публичный https-адрес этого сервера.'), { status: 400 });
  if (!url.startsWith('https://')) {
    throw Object.assign(new Error('Авито принимает только публичный https-адрес.'), { status: 400 });
  }
  await withToken(state.settings, (token) => subscribeWebhook(token, url));
  store.update((current) => {
    current.settings.webhookRegisteredUrl = url;
    current.lastError = null;
  });
  return url;
}

export async function removeWebhook(store) {
  const state = store.get();
  requireKeys(state.settings);
  const url = state.settings.webhookRegisteredUrl
    || composeWebhookUrl(state.settings.publicWebhookUrl, state.settings.webhookToken);
  if (!url) throw Object.assign(new Error('Подписка ещё не включалась.'), { status: 400 });
  await withToken(state.settings, (token) => unsubscribeWebhook(token, url));
  store.update((current) => {
    current.settings.webhookRegisteredUrl = '';
    current.lastError = null;
  });
}

export function acceptWebhook(store, body) {
  const parsed = parseWebhook(body);
  if (!parsed) return { accepted: true, created: false };
  store.update((state) => {
    const result = ingestWebhook(state, parsed);
    state.seenIds = result.seenIds;
    state.notifications = result.notifications;
  });
  return { accepted: true, created: true };
}

export function pushTestNotification(store) {
  const note = {
    id: `test-${Date.now()}`,
    chatId: '',
    peerName: 'Проверка',
    itemTitle: 'Локальное уведомление',
    text: 'Так выглядит сообщение, которое придёт с Авито.',
    createdAt: Date.now(),
  };
  store.update((state) => {
    state.notifications = [note, ...state.notifications].slice(0, 100);
  });
  return note;
}

export function notifyCurrentUnread(store) {
  store.update((state) => {
    const existing = new Set(state.notifications.map((note) => note.id));
    const fresh = [];
    for (const chat of state.chats) {
      if (!chat.unread || !chat.incoming) continue;
      const id = chat.last?.id || chat.id;
      if (!id || existing.has(id)) continue;
      fresh.push({
        id,
        chatId: chat.id,
        peerName: chat.peerName,
        itemTitle: chat.itemTitle,
        text: chat.preview,
        createdAt: chat.last?.createdAt || chat.updatedAt || Date.now(),
      });
    }
    if (fresh.length) state.notifications = [...fresh, ...state.notifications].slice(0, 100);
  });
}

export function dismissNotifications(store, { ids, all }) {
  store.update((state) => {
    if (all) {
      state.notifications = [];
      return;
    }
    const drop = new Set((ids || []).map(String));
    state.notifications = state.notifications.filter((note) => !drop.has(note.id));
  });
}

export function forget(store) {
  stop();
  clearToken();
  const token = store.get().settings.webhookToken;
  const next = blankState();
  next.settings.webhookToken = token;
  store.replace(next);
}
