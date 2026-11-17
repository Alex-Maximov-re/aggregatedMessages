import { messageKey, toMillis, webhookIsIncoming } from './avito.js';

function titleUpdates(notifications, chats) {
  const byId = new Map();
  for (const chat of chats) {
    const key = messageKey(chat.last, chat.id);
    if (key) byId.set(key, chat);
  }
  return notifications.map((note) => {
    const chat = byId.get(note.id);
    if (!chat) return note;
    return {
      ...note,
      chatId: chat.id || note.chatId,
      peerName: chat.peerName || note.peerName,
      itemTitle: chat.itemTitle || note.itemTitle,
    };
  });
}

export function ingestChats(state, chats, options = {}) {
  const notifyExisting = Boolean(options.notifyExisting);
  const seen = new Set(state.seenIds || []);
  const first = !state.primed;
  const fresh = [];

  for (const chat of chats) {
    const key = messageKey(chat.last, chat.id);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!chat.incoming) continue;
    if (first && !notifyExisting) continue;
    fresh.push({
      id: key,
      chatId: chat.id,
      peerName: chat.peerName,
      itemTitle: chat.itemTitle,
      text: chat.preview,
      createdAt: chat.last?.createdAt || chat.updatedAt || Date.now(),
    });
  }

  let notifications = titleUpdates(state.notifications || [], chats);
  if (fresh.length) notifications = [...fresh, ...notifications].slice(0, 100);

  return {
    seenIds: [...seen].slice(-3000),
    primed: true,
    notifications,
    fresh,
  };
}

export function ingestWebhook(state, parsed) {
  const seen = new Set(state.seenIds || []);
  if (!parsed?.id || seen.has(parsed.id)) {
    return { seenIds: [...seen].slice(-3000), notifications: state.notifications || [], fresh: [] };
  }
  seen.add(parsed.id);
  const seenIds = [...seen].slice(-3000);
  if (!webhookIsIncoming(parsed)) {
    return { seenIds, notifications: state.notifications || [], fresh: [] };
  }
  const note = {
    id: parsed.id,
    chatId: parsed.chatId,
    peerName: 'Новое сообщение',
    itemTitle: parsed.itemId ? `Объявление ${parsed.itemId}` : 'Авито',
    text: parsed.text || 'Новое сообщение',
    createdAt: toMillis(parsed.created) || Date.now(),
  };
  return {
    seenIds,
    notifications: [note, ...(state.notifications || [])].slice(0, 100),
    fresh: [note],
  };
}
