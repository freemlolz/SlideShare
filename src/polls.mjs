import { randomUUID } from 'node:crypto';

export const POLL_DURATION_MS = 10000;
const MAX_VOTES = 10000;

function invalid(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

export class PollSession {
  constructor(onChange, { now = Date.now } = {}) {
    this.onChange = onChange;
    this.now = now;
    this.poll = null;
    this.timer = null;
  }

  start(message) {
    this.settleExpiry();
    if (this.poll?.status === 'open') invalid('Опитування вже триває.', 409);
    const { question, options } = message ?? {};
    if (typeof question !== 'string' || !question.trim() || question.trim().length > 200
      || !Array.isArray(options) || ![2, 4].includes(options.length)) {
      invalid('Потрібні запитання й два або чотири варіанти відповіді.');
    }
    const answers = Array.from(options, (option) => {
      if (typeof option !== 'string' || !option.trim() || option.trim().length > 100) {
        invalid('Некоректний варіант відповіді.');
      }
      return option.trim();
    });
    if (new Set(answers.map((answer) => answer.toLowerCase())).size !== answers.length) {
      invalid('Варіанти відповіді мають відрізнятися.');
    }
    const startsAt = this.now();
    this.close();
    this.poll = { id: randomUUID(), question: question.trim(), options: Object.freeze(answers),
      status: 'open', startsAt, endsAt: startsAt + POLL_DURATION_MS, votes: new Map() };
    this.scheduleExpiry();
  }

  cancel(id) {
    if (!this.poll || this.poll.id !== id) invalid('Опитування вже змінилося.', 409);
    this.close();
    this.poll = null;
  }

  vote(message, voterId) {
    this.settleExpiry();
    const poll = this.poll;
    if (!poll || poll.id !== message?.pollId || poll.status !== 'open') {
      invalid('Опитування вже завершено або змінено.', 409);
    }
    const { answer } = message;
    if (!Number.isInteger(answer) || answer < 0 || answer >= poll.options.length) {
      invalid('Некоректний номер відповіді.');
    }
    if (typeof voterId !== 'string' || !voterId.trim()) invalid('Не визначено учасника.');
    if (poll.votes.has(voterId)) {
      if (poll.votes.get(voterId) !== answer) invalid('Відповідь уже зафіксовано.', 409);
      return;
    }
    if (poll.votes.size >= MAX_VOTES) invalid('Досягнуто межі кількості відповідей.', 413);
    poll.votes.set(voterId, answer);
  }

  snapshot(voterId) {
    this.settleExpiry();
    const poll = this.poll;
    if (!poll) return null;
    let counts = null;
    if (poll.status === 'results') {
      counts = Array(poll.options.length).fill(0);
      for (const answer of poll.votes.values()) counts[answer] += 1;
    }
    return { id: poll.id, question: poll.question, options: [...poll.options], status: poll.status,
      startsAt: poll.startsAt, endsAt: poll.endsAt, total: poll.votes.size,
      vote: poll.votes.get(voterId) ?? null, counts };
  }

  settleExpiry() {
    if (this.poll?.status !== 'open' || this.now() < this.poll.endsAt) return;
    this.poll.status = 'results';
    this.close();
    this.onChange?.();
  }

  scheduleExpiry() {
    const poll = this.poll;
    this.timer = setTimeout(() => {
      if (this.poll !== poll) return;
      this.settleExpiry();
      if (this.poll === poll && poll.status === 'open') this.scheduleExpiry();
    }, Math.max(1, poll.endsAt - this.now()));
    this.timer.unref();
  }

  close() {
    clearTimeout(this.timer);
    this.timer = null;
  }
}
