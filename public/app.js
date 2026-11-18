const workspace = document.querySelector('#workspace');
const statusNode = document.querySelector('#status');
const errorNode = document.querySelector('#error');
const form = document.querySelector('#setup-form');
const clientId = document.querySelector('#client-id');
const clientSecret = document.querySelector('#client-secret');
const pollSeconds = document.querySelector('#poll-seconds');
const notifyExisting = document.querySelector('#notify-existing');
const webhookUrl = document.querySelector('#webhook-url');
const webhookPreview = document.querySelector('#webhook-preview');
const chatList = document.querySelector('#chat-list');
const thread = document.querySelector('#thread');
const threadTitle = document.querySelector('#thread-title');
const threadSub = document.querySelector('#thread-sub');
const threadLink = document.querySelector('#thread-link');
const journal = document.querySelector('#journal');
const unreadCount = document.querySelector('#unread-count');
const settingsButton = document.querySelector('#settings-button');
const backButton = document.querySelector('#back-button');
const connectButton = document.querySelector('#connect-button');

let latest = null;
let hydrated = false;
const seenNotes = new Set();
let selectedChatId = '';
let showSettings = false;
let threadRequest = 0;
let audioCtx = null;

function formatTime(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function beep() {
  try {
    audioCtx ??= new AudioContext();
    const oscillator = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    oscillator.frequency.value = 880;
    oscillator.type = 'sine';
    gain.gain.value = 0.03;
    oscillator.connect(gain);
    gain.connect(audioCtx.destination);
    oscillator.start();
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.22);
    oscillator.stop(audioCtx.currentTime + 0.24);
  } catch {
    // звук необязателен
  }
}

async function askPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

function popup(note) {
  beep();
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const title = note.peerName || 'Авито';
  const body = [note.itemTitle, note.text].filter(Boolean).join(' — ');
  const notification = new Notification(title, { body });
  notification.onclick = () => {
    window.focus();
    if (note.chatId) selectChat(note.chatId);
  };
}

function setBusy(busy) {
  connectButton.disabled = busy;
  connectButton.textContent = busy ? 'Подключаю…' : 'Подключить';
}

function apiUrl(path) {
  const page = new URL(window.location.href);
  if (!page.pathname.endsWith('/')) page.pathname = page.pathname.replace(/[^/]*$/, '');
  return new URL(String(path).replace(/^\//, ''), page).href;
}

async function post(url, body) {
  const response = await fetch(apiUrl(url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok && data.error) throw new Error(data.error);
  if (!response.ok) throw new Error('Не удалось выполнить запрос.');
  return data;
}

function fillForm(state) {
  if (form.contains(document.activeElement)) return;
  clientId.value = state.settings.clientId || '';
  pollSeconds.value = state.settings.pollSeconds || 30;
  notifyExisting.checked = Boolean(state.settings.notifyExisting);
  webhookUrl.value = state.settings.publicWebhookUrl || '';
  clientSecret.placeholder = state.settings.secretSet ? 'сохранён, введите новый чтобы заменить' : '';
  clientSecret.required = !state.settings.secretSet;
}

function renderStatus(state) {
  const runtime = state.runtime || {};
  statusNode.className = 'status';
  let text = 'Нет ключей';
  if (runtime.polling) {
    statusNode.classList.add('busy');
    text = 'Проверяю Авито…';
  } else if (state.profile && state.lastError) {
    statusNode.classList.add('bad');
    text = state.profile.name || `ID ${state.profile.id}`;
  } else if (state.profile && runtime.running) {
    statusNode.classList.add('live');
    text = state.profile.name || `ID ${state.profile.id}`;
  } else if (state.profile) {
    text = 'На паузе';
  } else if (state.lastError && state.settings.secretSet) {
    statusNode.classList.add('bad');
    text = 'Ключи не приняты';
  } else if (state.lastError) {
    statusNode.classList.add('bad');
    text = 'Нет связи';
  } else if (state.settings.secretSet) {
    text = 'Ключи сохранены';
  }
  statusNode.replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'dot';
  const label = document.createElement('span');
  label.textContent = text;
  statusNode.append(dot, label);
  const connected = Boolean(state.profile);
  settingsButton.hidden = !connected;
  const live = connected && !showSettings;
  workspace.dataset.mode = live ? 'live' : 'setup';
  backButton.hidden = !showSettings || !connected;
}

function renderChats(state) {
  const unread = (state.chats || []).filter((chat) => chat.unread).length;
  unreadCount.hidden = unread === 0;
  unreadCount.textContent = String(unread);
  chatList.replaceChildren();
  if (!state.chats?.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = state.profile ? 'Чатов пока нет.' : 'Чаты появятся после подключения.';
    chatList.append(empty);
    return;
  }
  for (const chat of state.chats) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chat${chat.id === selectedChatId ? ' selected' : ''}`;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = chat.peerName || 'Собеседник';
    const time = document.createElement('small');
    time.textContent = formatTime(chat.updatedAt);
    const preview = document.createElement('span');
    preview.className = 'preview';
    preview.textContent = [chat.itemTitle, chat.preview].filter(Boolean).join(' — ');
    button.append(who, time, preview);
    if (chat.unread) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'новое';
      button.append(badge);
    }
    button.addEventListener('click', () => selectChat(chat.id));
    chatList.append(button);
  }
}

function renderJournal(state) {
  journal.replaceChildren();
  const notes = state.notifications || [];
  if (!notes.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Когда кто-то напишет на Авито, сообщение появится здесь.';
    journal.append(empty);
    return;
  }
  for (const note of notes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'note';
    const who = document.createElement('strong');
    who.textContent = note.peerName || 'Авито';
    const when = document.createElement('small');
    when.textContent = formatTime(note.createdAt);
    const text = document.createElement('p');
    text.textContent = [note.itemTitle, note.text].filter(Boolean).join(' — ');
    button.append(who, when, text);
    button.addEventListener('click', async () => {
      if (note.chatId) selectChat(note.chatId);
      await post('/api/notifications/dismiss', { ids: [note.id] }).catch(() => {});
    });
    journal.append(button);
  }
}

function renderWebhook(state) {
  const registered = state.settings.webhookRegisteredUrl;
  const preview = state.settings.webhookUrl;
  const problem = state.settings.webhookUrlError;
  if (registered) webhookPreview.textContent = `Авито подписан на ${registered}`;
  else if (problem) webhookPreview.textContent = problem;
  else if (preview) webhookPreview.textContent = `Адрес подписки: ${preview}`;
  else webhookPreview.textContent = 'После сохранения здесь появится адрес, который нужно отдать Авито.';
}

function renderError(state) {
  if (!state.lastError) {
    errorNode.hidden = true;
    errorNode.textContent = '';
    return;
  }
  errorNode.hidden = false;
  errorNode.textContent = state.lastError;
}

function render(state) {
  latest = state;
  fillForm(state);
  renderStatus(state);
  renderChats(state);
  renderJournal(state);
  renderWebhook(state);
  renderError(state);
  const freshCount = state.notifications?.length || 0;
  document.title = freshCount ? `(${freshCount}) Сводка` : 'Сводка — сообщения Авито';
}

function applyState(state) {
  const fresh = [];
  for (const note of state.notifications || []) {
    if (!seenNotes.has(note.id)) {
      if (hydrated) fresh.push(note);
      seenNotes.add(note.id);
    }
  }
  hydrated = true;
  render(state);
  for (const note of fresh) popup(note);
}

async function selectChat(chatId) {
  selectedChatId = chatId;
  showSettings = false;
  if (latest) render(latest);
  const chat = latest?.chats?.find((item) => item.id === chatId);
  threadTitle.textContent = chat?.peerName || 'Переписка';
  threadSub.textContent = chat?.itemTitle || '';
  if (chat?.itemUrl) {
    threadLink.hidden = false;
    threadLink.href = chat.itemUrl;
  } else {
    threadLink.hidden = true;
    threadLink.removeAttribute('href');
  }
  const request = ++threadRequest;
  thread.replaceChildren();
  const pending = document.createElement('p');
  pending.className = 'empty';
  pending.textContent = 'Загружаю сообщения…';
  thread.append(pending);
  try {
    const response = await fetch(apiUrl(`/api/messages?chatId=${encodeURIComponent(chatId)}`));
    const data = await response.json();
    if (request !== threadRequest) return;
    if (!response.ok) throw new Error(data.error || 'Не удалось открыть переписку.');
    thread.replaceChildren();
    if (!data.messages?.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'В чате нет сообщений.';
      thread.append(empty);
      return;
    }
    for (const message of data.messages) {
      const bubble = document.createElement('div');
      bubble.className = `bubble${message.mine ? ' mine' : ''}`;
      bubble.textContent = message.text;
      const time = document.createElement('time');
      time.textContent = formatTime(message.createdAt);
      bubble.append(time);
      thread.append(bubble);
    }
    thread.scrollTop = thread.scrollHeight;
  } catch (error) {
    if (request !== threadRequest) return;
    thread.replaceChildren();
    const failed = document.createElement('p');
    failed.className = 'empty';
    failed.textContent = error.message;
    thread.append(failed);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setBusy(true);
  errorNode.hidden = true;
  try {
    await askPermission();
    const data = await post('/api/settings', {
      clientId: clientId.value.trim(),
      clientSecret: clientSecret.value,
      pollSeconds: Number(pollSeconds.value),
      notifyExisting: notifyExisting.checked,
      publicWebhookUrl: webhookUrl.value.trim(),
      connect: true,
    });
    clientSecret.value = '';
    showSettings = false;
    if (data.state) applyState(data.state);
  } catch (error) {
    errorNode.hidden = false;
    errorNode.textContent = error.message;
  } finally {
    setBusy(false);
  }
});

document.querySelector('#stop-button').addEventListener('click', () => post('/api/stop').catch(showFailure));
document.querySelector('#forget-button').addEventListener('click', async () => {
  if (!confirm('Удалить сохранённые ключи Авито с этого компьютера?')) return;
  selectedChatId = '';
  showSettings = true;
  await post('/api/forget').catch(showFailure);
});
document.querySelector('#poll-now').addEventListener('click', () => post('/api/poll').catch(showFailure));
document.querySelector('#test-notification').addEventListener('click', async () => {
  await askPermission();
  await post('/api/test-notification').catch(showFailure);
});
document.querySelector('#enable-notifications').addEventListener('click', askPermission);
document.querySelector('#dismiss-all').addEventListener('click', () => post('/api/notifications/dismiss', { all: true }).catch(showFailure));
document.querySelector('#unread-now').addEventListener('click', () => post('/api/notifications/unread').catch(showFailure));
settingsButton.addEventListener('click', () => {
  showSettings = true;
  if (latest) render(latest);
});
backButton.addEventListener('click', () => {
  showSettings = false;
  if (latest) render(latest);
});
document.querySelector('#webhook-register').addEventListener('click', async () => {
  try {
    await post('/api/webhook/register', { publicWebhookUrl: webhookUrl.value.trim() });
  } catch (error) {
    showFailure(error);
  }
});
document.querySelector('#webhook-unsubscribe').addEventListener('click', () => post('/api/webhook/unsubscribe').catch(showFailure));

function showFailure(error) {
  errorNode.hidden = false;
  errorNode.textContent = error.message || 'Ошибка';
}

const events = new EventSource(apiUrl('/api/events'));
events.addEventListener('state', (event) => {
  applyState(JSON.parse(event.data));
});
events.onerror = () => {
  if (!latest) {
    errorNode.hidden = false;
    errorNode.textContent = 'Нет связи с локальным сервером сводки.';
  }
};
