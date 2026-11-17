import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  composeWebhookUrl,
  explainStatus,
  mergeChatLists,
  messageText,
  normalizeChatList,
  parseWebhook,
} from './avito.js';
import { ingestChats, ingestWebhook } from './ingest.js';
import { createStore, toPublic } from './store.js';

const sample = {
  chats: [
    {
      id: 'chat-1',
      updated: 1_700_000_000,
      unread_count: 1,
      users: [
        { id: 10, name: 'Я' },
        { id: 20, name: 'Марина' },
      ],
      context: { type: 'item', value: { title: 'Диван', url: 'https://www.avito.ru/item/1' } },
      last_message: {
        id: 'm1',
        author_id: 20,
        direction: 'in',
        type: 'text',
        created: 1_700_000_000,
        content: { text: 'Ещё актуально?' },
        isRead: false,
      },
    },
    {
      id: 'chat-2',
      updated: 1_700_000_100,
      users: [{ id: 10, name: 'Я' }, { id: 30, name: 'Олег' }],
      last_message: {
        id: 'm2',
        author_id: 10,
        direction: 'out',
        type: 'text',
        created: 1_700_000_100,
        content: { text: 'Да, пишите' },
      },
    },
  ],
};

test('normalizes chats and keeps the interlocutor', () => {
  const chats = normalizeChatList(sample, 10);
  assert.equal(chats[0].id, 'chat-2');
  assert.equal(chats[1].peerName, 'Марина');
  assert.equal(chats[1].itemTitle, 'Диван');
  assert.equal(chats[1].preview, 'Ещё актуально?');
  assert.equal(chats[1].incoming, true);
  assert.equal(chats[1].unread, true);
  assert.equal(chats[0].incoming, false);
});

test('first poll remembers messages without notifying', () => {
  const chats = normalizeChatList(sample, 10);
  const result = ingestChats({ seenIds: [], primed: false, notifications: [] }, chats, { notifyExisting: false });
  assert.equal(result.fresh.length, 0);
  assert.equal(result.primed, true);
  assert.ok(result.seenIds.includes('m1'));
});

test('notifies only about a new incoming message', () => {
  const initial = normalizeChatList(sample, 10);
  const primed = ingestChats({ seenIds: [], primed: false, notifications: [] }, initial, {});
  const next = normalizeChatList({
    chats: [
      sample.chats[1],
      {
        ...sample.chats[0],
        updated: 1_700_000_200,
        last_message: {
          ...sample.chats[0].last_message,
          id: 'm3',
          created: 1_700_000_200,
          content: { text: 'Можно сегодня?' },
        },
      },
    ],
  }, 10);
  const result = ingestChats({ seenIds: primed.seenIds, primed: true, notifications: [] }, next, {});
  assert.equal(result.fresh.length, 1);
  assert.equal(result.fresh[0].text, 'Можно сегодня?');
  assert.equal(result.fresh[0].peerName, 'Марина');
});

test('does not notify about own outgoing message', () => {
  const primed = ingestChats(
    { seenIds: [], primed: false, notifications: [] },
    normalizeChatList(sample, 10),
    {},
  );
  const own = normalizeChatList({
    chats: [{
      ...sample.chats[1],
      last_message: { ...sample.chats[1].last_message, id: 'm4', content: { text: 'Жду' } },
    }],
  }, 10);
  const result = ingestChats({ seenIds: primed.seenIds, primed: true, notifications: [] }, own, {});
  assert.equal(result.fresh.length, 0);
  assert.ok(result.seenIds.includes('m4'));
});

test('webhook creates one notification and ignores duplicates and outgoing', () => {
  const incoming = parseWebhook({
    payload: {
      type: 'message',
      value: {
        id: 'm9',
        chat_id: 'chat-1',
        user_id: 10,
        author_id: 20,
        created: 1_700_000_300,
        type: 'text',
        content: { text: 'Алло' },
        item_id: 5,
      },
    },
  });
  const first = ingestWebhook({ seenIds: [], notifications: [] }, incoming);
  const second = ingestWebhook({ seenIds: first.seenIds, notifications: first.notifications }, incoming);
  assert.equal(first.fresh.length, 1);
  assert.equal(first.fresh[0].text, 'Алло');
  assert.equal(second.fresh.length, 0);

  const outgoing = parseWebhook({
    payload: {
      type: 'message',
      value: { id: 'm10', chat_id: 'chat-1', user_id: 10, author_id: 10, type: 'text', content: { text: 'Сам себе' } },
    },
  });
  const skipped = ingestWebhook({ seenIds: second.seenIds, notifications: second.notifications }, outgoing);
  assert.equal(skipped.fresh.length, 0);
  assert.ok(skipped.seenIds.includes('m10'));
});

test('labels non-text messages and merges unread flag', () => {
  assert.equal(messageText({ type: 'image', content: {} }), 'Изображение');
  const recent = [{ id: 'a', updatedAt: 10, unread: false, peerName: 'А' }];
  const unread = [{ id: 'a', updatedAt: 5, unread: true, peerName: 'А' }];
  const merged = mergeChatLists(unread, recent);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].unread, true);
  assert.equal(merged[0].updatedAt, 10);
});

test('explains an oauth error even when Avito answers HTTP 200', () => {
  const message = explainStatus(401, {
    error: 'unauthorized_client',
    error_description: 'The client is not authorized to request a token using this method.',
  });
  assert.match(message, /не выдал токен/);
  assert.equal(message.includes('The client is not authorized'), false);
});

test('composes a public webhook url and never publishes the secret', () => {
  const url = new URL(composeWebhookUrl('https://example.com', 'tok en'));
  assert.equal(url.pathname, '/api/webhook');
  assert.equal(url.searchParams.get('token'), 'tok en');
  assert.equal(composeWebhookUrl('https://example.com/hook?token=ready', 'other'), 'https://example.com/hook?token=ready');

  const file = path.join(os.tmpdir(), `avito-state-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const store = createStore(file);
  store.update((state) => {
    state.settings.clientId = 'client';
    state.settings.clientSecret = 'super-secret-value';
  });
  const published = JSON.stringify(toPublic(store.get(), { running: false, polling: false, nextPollAt: null }));
  assert.equal(published.includes('super-secret-value'), false);
  assert.equal(published.includes('"secretSet":true'), true);
  fs.rmSync(file, { force: true });
});
