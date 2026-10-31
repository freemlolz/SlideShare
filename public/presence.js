const statuses = { connected: 'Підключено', fallback: 'HTTP-резерв', reconnecting: 'Відновлює зв’язок', disconnected: 'Від’єднано' };

export function createPresencePanel({ root, onRemove, onError }) {
  root.innerHTML = `<p class="eyebrow">ЗВ’ЯЗОК З АУДИТОРІЄЮ</p><h2>Стан учасників</h2>
    <div class="presence-totals"></div><p class="presence-empty small muted">Очікуємо дані сервера…</p>
    <div class="presence-list" aria-label="Список учасників"></div>
    <p class="small muted presence-note">Один запис — профіль браузера, не фізичний телефон. Сон або фонова вкладка можуть виглядати як від’єднання.</p>`;
  const totals = root.querySelector('.presence-totals');
  const list = root.querySelector('.presence-list');
  const empty = root.querySelector('.presence-empty');
  const rows = new Map();
  const counters = new Map();
  let serverTime = 0;
  let receivedAt = performance.now();
  for (const [status, label] of Object.entries(statuses)) {
    const metric = document.createElement('div');
    metric.dataset.status = status;
    const count = document.createElement('strong');
    count.textContent = '0';
    const caption = document.createElement('span');
    caption.textContent = label;
    metric.append(count, caption);
    totals.append(metric);
    counters.set(status, count);
  }

  function updateAges() {
    const now = serverTime + performance.now() - receivedAt;
    for (const { element, participant } of rows.values()) {
      const seconds = Math.max(0, Math.floor((now - participant.lastSeen) / 1000));
      const age = element.querySelector('.presence-last-seen');
      const text = seconds < 2 ? 'Щойно на зв’язку' : `Останній зв’язок: ${seconds} с тому`;
      if (age.textContent !== text) age.textContent = text;
    }
  }
  setInterval(updateAges, 1000);

  return {
    update(state) {
      if (!state.presence) {
        empty.hidden = false;
        empty.textContent = 'Для цієї панелі перезапустіть сервер та відкрийте нове посилання ведучого.';
        return;
      }
      serverTime = state.serverTime;
      receivedAt = performance.now();
      const { participants } = state.presence;
      for (const [status, counter] of counters) counter.textContent = state.presence.totals[status];
      empty.hidden = participants.length !== 0;
      empty.textContent = 'Ще ніхто не приєднався.';
      const ids = new Set(participants.map((participant) => participant.id));
      for (const [id, row] of rows) if (!ids.has(id)) { row.element.remove(); rows.delete(id); }
      for (const participant of participants) {
        let row = rows.get(participant.id);
        if (!row) {
          const element = document.createElement('article');
          element.className = 'presence-participant';
          element.innerHTML = '<div class="presence-row-heading"><strong></strong><span class="presence-status"></span></div><p class="presence-preload"></p><p class="presence-last-seen"></p><button type="button" class="presence-remove">Прибрати запис</button>';
          row = { element, participant, removing: false };
          rows.set(participant.id, row);
          list.append(element);
          element.querySelector('.presence-remove').addEventListener('click', async () => {
            if (row.removing) return;
            row.removing = true;
            const button = element.querySelector('button');
            button.disabled = true;
            try { await onRemove(participant.id); }
            catch (error) { onError(error.message); }
            finally { row.removing = false; button.disabled = false; }
          });
        }
        row.participant = participant;
        row.element.dataset.status = participant.status;
        row.element.dataset.participantId = participant.id;
        row.element.querySelector('strong').textContent = participant.label;
        row.element.querySelector('.presence-status').textContent = statuses[participant.status];
        row.element.querySelector('.presence-preload').textContent = `${participant.transport ?? 'Немає зв’язку'} · ${participant.openSockets} WS-вкладок · ${participant.total ? `слайди ${participant.loaded} / ${participant.total}` : 'PDF ще немає'}`;
        row.element.querySelector('.presence-remove').hidden = participant.status !== 'disconnected';
      }
      updateAges();
    },
  };
}
