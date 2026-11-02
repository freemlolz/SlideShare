import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function validatePolls(value) {
  if (!Array.isArray(value) || value.length > 50 || value.some((poll) => !poll
    || typeof poll.id !== 'string' || !poll.id || poll.id.length > 100
    || typeof poll.question !== 'string' || !poll.question.trim() || poll.question.length > 200
    || !Array.isArray(poll.options) || ![2, 4].includes(poll.options.length)
    || poll.options.some((option) => typeof option !== 'string' || !option.trim() || option.length > 100))) {
    throw new Error('Некоректне сховище опитувань.');
  }
  return value.map(({ id, question, options }) => ({ id, question, options: [...options] }));
}

export function createDesktopStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'desktop-state.json');
  let state = { version: 1, port: 3000, polls: [] };
  try {
    const saved = JSON.parse(readFileSync(filename, 'utf8'));
    if (saved.version !== 1 || !Number.isInteger(saved.port) || saved.port < 1 || saved.port > 65535) throw new Error();
    state = { version: 1, port: saved.port, polls: validatePolls(saved.polls) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Не вдалося прочитати збережені опитування. Файл desktop-state.json залишено без змін.');
  }
  function save(next) {
    writeFileSync(`${filename}.tmp`, JSON.stringify(next), { mode: 0o600 });
    renameSync(`${filename}.tmp`, filename);
    state = next;
  }
  return {
    get port() { return state.port; },
    setPort(port) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Некоректний порт.');
      save({ ...state, port });
    },
    readPolls() { return JSON.stringify(state.polls); },
    writePolls(serialized) {
      if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 256 * 1024) throw new Error('Завелике сховище опитувань.');
      save({ ...state, polls: validatePolls(JSON.parse(serialized)) });
    },
  };
}
