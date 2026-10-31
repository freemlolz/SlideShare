export const PRESENCE_LIMITS = { participants: 500, httpFreshMs: 10000, socketFreshMs: 25000, disconnectedMs: 35000 };

export class PresenceRegistry {
  constructor({ now = Date.now, limit = PRESENCE_LIMITS.participants } = {}) {
    this.now = now;
    this.limit = limit;
    this.entries = new Map();
    this.sequence = 0;
  }

  entry(identity) {
    let entry = this.entries.get(identity);
    if (!entry && this.entries.size < this.limit) {
      entry = { id: ++this.sequence, lastSeen: this.now(), httpAt: null, httpEligible: true,
        sockets: new Map(), progress: null, httpProgress: null, reportedStatus: null };
      this.entries.set(identity, entry);
    }
    return entry;
  }

  http(identity) {
    const entry = this.entry(identity);
    if (!entry) return false;
    entry.httpAt = entry.lastSeen = this.now();
    entry.httpEligible = true;
    return true;
  }

  connect(identity, socket) {
    const entry = this.entry(identity);
    if (!entry) return false;
    entry.lastSeen = this.now();
    entry.sockets.set(socket, { seenAt: entry.lastSeen, progress: null });
    return true;
  }

  pong(identity, socket) {
    const entry = this.entries.get(identity);
    const connection = entry?.sockets.get(socket);
    if (!connection) { this.connect(identity, socket); return; }
    connection.seenAt = entry.lastSeen = this.now();
  }

  disconnect(identity, socket) {
    const entry = this.entries.get(identity);
    if (!entry?.sockets.delete(socket)) return;
    if (!entry.sockets.size) entry.httpEligible = false;
  }

  ready(identity, progress, socket) {
    const entry = this.entries.get(identity);
    if (!entry) return;
    if (socket) {
      const connection = entry.sockets.get(socket);
      if (!connection) return;
      connection.progress = { ...progress };
      this.pong(identity, socket);
    } else {
      this.http(identity);
      entry.httpProgress = { ...progress };
    }
    entry.progress = { ...progress };
  }

  status(entry) {
    const now = this.now();
    if ([...entry.sockets.values()].some((connection) => now - connection.seenAt < PRESENCE_LIMITS.socketFreshMs)) return 'connected';
    if (entry.httpAt !== null && now - entry.httpAt < PRESENCE_LIMITS.httpFreshMs
      && entry.httpEligible) return 'fallback';
    return now - entry.lastSeen >= PRESENCE_LIMITS.disconnectedMs ? 'disconnected' : 'reconnecting';
  }

  sweep() {
    let changed = false;
    for (const entry of this.entries.values()) {
      const status = this.status(entry);
      if (status !== entry.reportedStatus) { entry.reportedStatus = status; changed = true; }
    }
    return changed;
  }

  snapshot(deck) {
    const totals = { connected: 0, fallback: 0, reconnecting: 0, disconnected: 0 };
    const participants = [...this.entries.values()].map((entry) => {
      const status = this.status(entry);
      totals[status] += 1;
      const active = [...entry.sockets.values()].filter((connection) => this.now() - connection.seenAt < PRESENCE_LIMITS.socketFreshMs);
      const reports = status === 'connected' ? active.map((connection) => connection.progress)
        : [status === 'fallback' ? entry.httpProgress : entry.progress];
      const loaded = deck ? Math.max(0, ...reports.filter((report) => report?.deckId === deck.id).map((report) => report.loaded)) : 0;
      return { id: entry.id, label: `Учасник ${entry.id}`, status, lastSeen: entry.lastSeen,
        openSockets: entry.sockets.size, transport: status === 'connected' ? 'WebSocket' : status === 'fallback' ? 'HTTP' : null,
        loaded, total: deck?.pages.length ?? 0 };
    });
    return { totals, participants, limit: this.limit };
  }

  remove(id) {
    const match = [...this.entries].find(([, entry]) => entry.id === id);
    if (!match) throw Object.assign(new Error('Учасника вже видалено.'), { status: 404 });
    if (this.status(match[1]) !== 'disconnected') throw Object.assign(new Error('Можна прибрати лише від’єднаного учасника.'), { status: 409 });
    this.entries.delete(match[0]);
  }
}
