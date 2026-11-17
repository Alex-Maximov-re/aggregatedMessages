import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { friendlyError } from './lib/avito.js';
import {
  acceptWebhook,
  dismissNotifications,
  forget,
  getRuntime,
  loadMessages,
  notifyCurrentUnread,
  pollOnce,
  pushTestNotification,
  registerWebhook,
  removeWebhook,
  reschedule,
  saveSettings,
  start,
  stop,
} from './lib/monitor.js';
import { createStore, toPublic } from './lib/store.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const store = createStore(path.join(root, 'data', 'state.json'));
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3780);
const clients = new Set();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function publicState() {
  return toPublic(store.get(), getRuntime());
}

function broadcast() {
  const payload = publicState();
  for (const client of clients) client.send('state', payload);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(Object.assign(new Error('Слишком большой запрос.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Некорректный JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function tokenMatches(given, expected) {
  if (!given || !expected) return false;
  const left = Buffer.from(String(given));
  const right = Buffer.from(String(expected));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = path.resolve(publicDir, `.${pathname}`);
  if (file !== publicDir && !file.startsWith(publicDir + path.sep)) {
    sendJson(res, 403, { error: 'Запрещено.' });
    return;
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      sendJson(res, 404, { error: 'Не найдено.' });
      return;
    }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function openEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write('\n');
  const client = {
    send(event, data) {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        clients.delete(client);
      }
    },
  };
  clients.add(client);
  client.send('state', publicState());
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 15_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(client);
  });
}

async function route(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    sendJson(res, 200, publicState());
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    openEvents(req, res);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/settings') {
    const body = await readBody(req);
    saveSettings(store, body);
    if (body.connect) {
      const settings = store.get().settings;
      if (!settings.clientId || !settings.clientSecret) {
        sendJson(res, 400, { error: 'Нужны Client ID и Client Secret из кабинета Авито.', state: publicState() });
        return true;
      }
      stop();
      const result = await pollOnce(store);
      const permanent = [400, 401, 402, 403].includes(result.status);
      if (result.ok || !permanent) start(store, broadcast, { immediate: false });
      else broadcast();
      sendJson(res, result.ok ? 200 : result.status || 502, {
        error: result.error || null,
        state: publicState(),
      });
      return true;
    }
    if (getRuntime().running) reschedule();
    broadcast();
    sendJson(res, 200, { state: publicState() });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/poll') {
    const result = await pollOnce(store);
    broadcast();
    sendJson(res, result.ok ? 200 : 502, { error: result.error || null, state: publicState() });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/stop') {
    stop();
    broadcast();
    sendJson(res, 200, { state: publicState() });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/forget') {
    forget(store);
    broadcast();
    sendJson(res, 200, { state: publicState() });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/test-notification') {
    pushTestNotification(store);
    broadcast();
    sendJson(res, 200, { state: publicState() });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/notifications/unread') {
    notifyCurrentUnread(store);
    broadcast();
    sendJson(res, 200, { state: publicState() });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/notifications/dismiss') {
    const body = await readBody(req);
    dismissNotifications(store, { ids: body.ids, all: Boolean(body.all) });
    broadcast();
    sendJson(res, 200, { state: publicState() });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/messages') {
    const chatId = url.searchParams.get('chatId');
    if (!chatId) {
      sendJson(res, 400, { error: 'Не указан чат.' });
      return true;
    }
    const messages = await loadMessages(store, chatId);
    sendJson(res, 200, { messages });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/webhook/register') {
    const body = await readBody(req);
    if (typeof body.publicWebhookUrl === 'string') saveSettings(store, { publicWebhookUrl: body.publicWebhookUrl });
    const webhookUrl = await registerWebhook(store);
    broadcast();
    sendJson(res, 200, { webhookUrl, state: publicState() });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/webhook/unsubscribe') {
    await removeWebhook(store);
    broadcast();
    sendJson(res, 200, { state: publicState() });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/webhook') {
    const expected = store.get().settings.webhookToken;
    if (!tokenMatches(url.searchParams.get('token'), expected)) {
      sendJson(res, 401, { ok: false });
      return true;
    }
    try {
      const body = await readBody(req);
      acceptWebhook(store, body);
      broadcast();
    } catch (error) {
      console.error(`Webhook не разобран: ${friendlyError(error)}`);
    }
    sendJson(res, 200, { ok: true });
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${host}`);
  try {
    const handled = await route(req, res, url);
    if (!handled) serveStatic(req, res, url);
  } catch (error) {
    if (res.headersSent) return;
    sendJson(res, error.status || 500, { error: friendlyError(error), state: publicState() });
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Порт ${port} занят. Закройте другой процесс или задайте переменную PORT.`);
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});

server.listen(port, host, () => {
  const settings = store.get().settings;
  if (settings.clientId && settings.clientSecret) start(store, broadcast, { immediate: true });
  console.log(`Сводка слушает http://${host}:${port}`);
});
