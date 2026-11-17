const API = 'https://api.avito.ru';

const TYPE_LABELS = {
  image: 'Изображение',
  voice: 'Голосовое сообщение',
  call: 'Звонок',
  appCall: 'Звонок',
  item: 'Объявление',
  location: 'Геопозиция',
  link: 'Ссылка',
  system: 'Системное сообщение',
  deleted: 'Сообщение удалено',
};

const OAUTH_ERRORS = {
  invalid_client: 'Авито не принял Client ID или Client Secret.',
  unauthorized_client: 'Авито не выдал токен по этим ключам. Нужен ключ из раздела «Для профессионалов» → API в своём кабинете.',
  invalid_grant: 'Авито отклонил запрос токена. Проверьте ключ.',
};

export function explainStatus(status, body) {
  if (typeof body?.error === 'string' && OAUTH_ERRORS[body.error]) return OAUTH_ERRORS[body.error];
  if (body && typeof body.error_description === 'string' && body.error_description.trim()) {
    return body.error_description.trim();
  }
  const nested = body?.error;
  if (nested && typeof nested === 'object' && typeof nested.message === 'string' && nested.message.trim()) {
    return nested.message.trim();
  }
  if (typeof nested === 'string' && nested.trim() && nested !== 'invalid_client') {
    return nested.trim();
  }
  if (typeof body?.message === 'string' && body.message.trim()) return body.message.trim();
  if (status === 401 || status === 403) {
    return 'Авито не принял ключи или у ключа нет доступа к мессенджеру (messenger:read) и профилю (user:read).';
  }
  if (status === 402) {
    return 'На этом тарифе Авито не отдаёт мессенджер по API. Нужен платный тариф для профессионалов.';
  }
  if (status === 429) return 'Авито ограничил частоту запросов. Следующая проверка будет позже.';
  if (status) return `Авито ответил с кодом ${status}.`;
  return 'Не удалось обратиться к Авито.';
}

export function friendlyError(error) {
  if (!error) return 'Неизвестная ошибка.';
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'Авито не ответил вовремя.';
  const code = error.cause?.code;
  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN' || code === 'ENETUNREACH') {
    return 'Нет соединения с api.avito.ru.';
  }
  if (String(error.message || '').includes('fetch failed')) return 'Нет соединения с api.avito.ru.';
  return error.message || 'Не удалось обратиться к Авито.';
}

export async function avitoFetch(pathname, { token, method = 'GET', body, form } = {}) {
  const headers = { Accept: 'application/json' };
  let payload;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form);
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(API + pathname, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw Object.assign(new Error(friendlyError(error)), { cause: error });
  }

  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { message: text.slice(0, 300) };
    }
  }
  const oauthError = json && typeof json.error === 'string' && json.error;
  if (!response.ok || oauthError) {
    const status = response.ok ? 401 : response.status;
    const error = new Error(explainStatus(status, json));
    error.status = status;
    error.payload = json;
    throw error;
  }
  return json;
}

export async function fetchToken(clientId, clientSecret) {
  const form = {
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  };
  let json;
  try {
    json = await avitoFetch('/token', { method: 'POST', form });
  } catch (error) {
    if (error.status !== 404) throw error;
    json = await avitoFetch('/token/', { method: 'POST', form });
  }
  if (!json?.access_token) throw new Error('Авито не вернул токен доступа.');
  const expiresIn = Number(json.expires_in) || 3600;
  return {
    accessToken: json.access_token,
    expiresAt: Date.now() + expiresIn * 1000 - 60_000,
  };
}

export async function fetchProfile(token) {
  const json = await avitoFetch('/core/v1/accounts/self', { token });
  const source = json?.id != null ? json : json?.result;
  if (source?.id == null) {
    throw new Error('Авито не вернул номер профиля. Нужен доступ user:read.');
  }
  return { id: source.id, name: source.name || '' };
}

export async function fetchChats(token, userId, { limit = 50, offset = 0, unreadOnly = false } = {}) {
  const query = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (unreadOnly) query.set('unread_only', 'true');
  return avitoFetch(`/messenger/v2/accounts/${encodeURIComponent(userId)}/chats?${query}`, { token });
}

export async function fetchMessages(token, userId, chatId) {
  const query = new URLSearchParams({ limit: '50', offset: '0' });
  return avitoFetch(
    `/messenger/v3/accounts/${encodeURIComponent(userId)}/chats/${encodeURIComponent(chatId)}/messages?${query}`,
    { token },
  );
}

export async function subscribeWebhook(token, url) {
  return avitoFetch('/messenger/v3/webhook', { method: 'POST', token, body: { url } });
}

export async function unsubscribeWebhook(token, url) {
  return avitoFetch('/messenger/v1/webhook/unsubscribe', { method: 'POST', token, body: { url } });
}

export function toMillis(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'string' && value.includes('-')) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number < 1e12 ? number * 1000 : number;
}

export function messageText(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (typeof message.text === 'string' && message.text.trim()) return message.text.trim();
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string' && content.text.trim()) return content.text.trim();
    if (typeof content.text?.text === 'string' && content.text.text.trim()) return content.text.text.trim();
    if (typeof content.link?.url === 'string') return content.link.url;
    if (typeof content.url === 'string') return content.url;
  }
  return TYPE_LABELS[message.type] || (message.type ? `Сообщение (${message.type})` : 'Новое сообщение');
}

export function isIncoming(message, userId) {
  if (!message) return false;
  if (message.direction === 'out') return false;
  if (message.direction === 'in') return true;
  const authorId = message.author_id ?? message.authorId;
  if (authorId != null && userId != null) return String(authorId) !== String(userId);
  return false;
}

export function isMine(message, userId) {
  if (!message) return false;
  if (message.direction === 'out') return true;
  if (message.direction === 'in') return false;
  const authorId = message.author_id ?? message.authorId;
  if (authorId != null && userId != null) return String(authorId) === String(userId);
  return false;
}

export function messageKey(message, chatId) {
  if (!message) return '';
  if (message.id) return String(message.id);
  const created = message.created ?? message.createdAt ?? '';
  const text = message.text || messageText(message);
  return `${chatId}:${created}:${text}`;
}

export function safeHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString();
  } catch {
    return '';
  }
  return '';
}

function authorIdOf(message) {
  return message?.author_id ?? message?.authorId ?? null;
}

function isUnread(rawChat, message, userId) {
  const count = rawChat?.unread_count ?? rawChat?.unreadCount;
  if (typeof count === 'number') return count > 0;
  if (typeof message?.isRead === 'boolean') return message.isRead === false;
  if (typeof message?.is_read === 'boolean') return message.is_read === false;
  if (message?.read === null) return isIncoming(message, userId);
  return false;
}

function peerFrom(raw, userId) {
  const users = Array.isArray(raw?.users) ? raw.users : [];
  const peer = users.find((user) => String(user.id) !== String(userId)) || users[0];
  return peer?.name || 'Собеседник';
}

function itemFrom(raw) {
  const value = raw?.context?.value || raw?.context || {};
  const title = value.title || value.item?.title || '';
  const url = safeHttpUrl(value.url || value.item?.url || '');
  return { title, url };
}

function slimMessage(message) {
  if (!message || typeof message !== 'object') return null;
  return {
    id: message.id ? String(message.id) : '',
    authorId: authorIdOf(message),
    direction: message.direction || '',
    type: message.type || '',
    text: messageText(message),
    created: message.created ?? message.createdAt ?? null,
    createdAt: toMillis(message.created ?? message.createdAt),
    isRead: message.isRead ?? message.is_read,
  };
}

export function normalizeChat(raw, userId) {
  const last = slimMessage(raw?.last_message || raw?.lastMessage);
  const item = itemFrom(raw);
  const peerName = peerFrom(raw, userId);
  const updatedAt = toMillis(raw?.updated || raw?.created || last?.created);
  return {
    id: String(raw?.id ?? raw?.chat_id ?? ''),
    peerName,
    itemTitle: item.title,
    itemUrl: item.url,
    updatedAt,
    preview: last?.text || '',
    incoming: isIncoming(last, userId),
    unread: isUnread(raw, raw?.last_message || raw?.lastMessage, userId),
    last,
  };
}

export function extractChats(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.chats)) return payload.chats;
  if (Array.isArray(payload?.result?.chats)) return payload.result.chats;
  return [];
}

export function normalizeChatList(payload, userId) {
  return extractChats(payload)
    .map((chat) => normalizeChat(chat, userId))
    .filter((chat) => chat.id)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function mergeChatLists(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const chat of list || []) {
      const previous = map.get(chat.id);
      if (!previous || (chat.updatedAt || 0) >= (previous.updatedAt || 0)) {
        map.set(chat.id, { ...chat, unread: Boolean(chat.unread || previous?.unread) });
      } else if (chat.unread) {
        map.set(chat.id, { ...previous, unread: true });
      }
    }
  }
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function normalizeMessages(payload, userId) {
  const list = Array.isArray(payload)
    ? payload
    : payload?.messages || payload?.result?.messages || [];
  return list
    .map((message) => ({
      id: String(message.id || ''),
      text: messageText(message),
      createdAt: toMillis(message.created),
      mine: isMine(message, userId),
      type: message.type || 'text',
    }))
    .filter((message) => message.id || message.text)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function parseWebhook(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.payload?.type && body.payload.type !== 'message') return null;
  const value = body.payload?.value || body.value || (body.chat_id || body.message_id || body.author_id ? body : null);
  if (!value || typeof value !== 'object') return null;
  const id = value.id || value.message_id;
  const chatId = value.chat_id || value.chatId || '';
  if (!id && !chatId) return null;
  return {
    id: String(id || `${chatId}:${value.created || Date.now()}`),
    chatId: String(chatId),
    authorId: value.author_id ?? value.authorId ?? null,
    userId: value.user_id ?? value.userId ?? null,
    type: value.type || 'text',
    text: messageText(value),
    created: value.created ?? value.created_at ?? Date.now(),
    itemId: value.item_id ?? value.itemId ?? null,
  };
}

export function webhookIsIncoming(parsed) {
  if (parsed?.authorId == null || parsed?.userId == null) return true;
  return String(parsed.authorId) !== String(parsed.userId);
}

export function composeWebhookUrl(input, token) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Публичный адрес должен быть полной ссылкой, например https://example.com');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Адрес должен начинаться с https://');
  }
  if (!url.pathname || url.pathname === '/') url.pathname = '/api/webhook';
  if (!url.searchParams.has('token') && token) url.searchParams.set('token', token);
  return url.toString();
}
