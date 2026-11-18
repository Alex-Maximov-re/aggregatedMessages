import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { blankState, mergeState } from './state.js';

export { applySettings, blankState, mergeState, toPublic } from './state.js';

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
