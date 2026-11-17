import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { composeWebhookUrl } from './avito.js';

export function blankState() {
  return {
    settings: {
      clientId: '',
      clientSecret: '',
      pollSeconds: 30,
      notifyExisting: false,
      publicWebhookUrl: '',
      webhookToken: '',
      webhookRegisteredUrl: '',
    },
    profile: null,
    primed: false,
    seenIds: [],
    chats: [],
    notifications: [],
    lastError: null,
    lastPollAt: null,
  };
}

function mergeState(loaded) {
  const base = blankState();
  const source = loaded && typeof loaded === 'object' ? loaded : {};
  return {
    ...base,
    ...source,
    settings: { ...base.settings, ...(source.settings || {}) },
    seenIds: Array.isArray(source.seenIds) ? source.seenIds : [],
    chats: Array.isArray(source.chats) ? source.chats : [],
    notifications: Array.isArray(source.notifications) ? source.notifications : [],
    profile: source.profile || null,
  };
}

export function createStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let state = blankState();

  function save() {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  }

  try {
    state = mergeState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      const backup = `${file}.bak`;
      try {
        fs.rmSync(backup, { force: true });
        fs.renameSync(file, backup);
      } catch {
        // оставляем повреждённый файл на месте, если переименовать его нельзя
      }
    }
  }

  if (!state.settings.webhookToken) {
    state.settings.webhookToken = crypto.randomBytes(16).toString('hex');
    save();
  }

  return {
    get() {
      return state;
    },
    update(mutator) {
      mutator(state);
      save();
      return state;
    },
    replace(next) {
      state = mergeState(next);
      if (!state.settings.webhookToken) state.settings.webhookToken = crypto.randomBytes(16).toString('hex');
      save();
      return state;
    },
  };
}

export function applySettings(state, input) {
  const settings = { ...state.settings };
  const nextId = typeof input.clientId === 'string' ? input.clientId.trim() : settings.clientId;
  const nextSecret = typeof input.clientSecret === 'string' && input.clientSecret.trim()
    ? input.clientSecret.trim()
    : settings.clientSecret;
  if (input.pollSeconds != null && input.pollSeconds !== '') {
    const seconds = Number(input.pollSeconds);
    if (!Number.isFinite(seconds)) throw Object.assign(new Error('Интервал должен быть числом.'), { status: 400 });
    settings.pollSeconds = Math.min(300, Math.max(15, Math.round(seconds)));
  }
  if (typeof input.notifyExisting === 'boolean') settings.notifyExisting = input.notifyExisting;
  if (typeof input.publicWebhookUrl === 'string') settings.publicWebhookUrl = input.publicWebhookUrl.trim();
  const keysChanged = nextId !== state.settings.clientId || nextSecret !== state.settings.clientSecret;
  settings.clientId = nextId;
  settings.clientSecret = nextSecret;
  return { settings, keysChanged };
}

export function toPublic(state, runtime) {
  let webhookUrl = '';
  let webhookUrlError = '';
  try {
    webhookUrl = composeWebhookUrl(state.settings.publicWebhookUrl, state.settings.webhookToken);
  } catch (error) {
    webhookUrlError = error.message;
  }
  return {
    profile: state.profile,
    primed: Boolean(state.primed),
    chats: state.chats,
    notifications: state.notifications,
    lastError: state.lastError,
    lastPollAt: state.lastPollAt,
    settings: {
      clientId: state.settings.clientId,
      secretSet: Boolean(state.settings.clientSecret),
      pollSeconds: state.settings.pollSeconds,
      notifyExisting: Boolean(state.settings.notifyExisting),
      publicWebhookUrl: state.settings.publicWebhookUrl,
      webhookToken: state.settings.webhookToken,
      webhookRegisteredUrl: state.settings.webhookRegisteredUrl,
      webhookUrl,
      webhookUrlError,
    },
    runtime,
  };
}
