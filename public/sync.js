export function takeToken(role) {
  const key = `slidesync-${role}-token`;
  const fragment = new URLSearchParams(location.hash.slice(1));
  let token = fragment.get('token');
  try {
    if (token) sessionStorage.setItem(key, token);
    else token = sessionStorage.getItem(key);
  } catch {}
  if (fragment.has('token')) history.replaceState(null, '', location.pathname);
  return token;
}

export function createSync({ role, token, onState, onConnection, onError, onOpen }) {
  let socket;
  let stopped = false;
  let reconnectTimer;
  let retry = 500;
  let lastMessage = 0;
  let lastRevision = -1;
  let sessionId;
  let polling = false;
  let pendingReady;
  let latestReady;
  let reportingReady = false;

  const headers = role === 'host' ? { 'X-Host-Token': token } : {};
  const stateUrl = role === 'host' ? '/api/state' : `/api/state?token=${encodeURIComponent(token)}`;

  async function flushReady() {
    if (reportingReady || !pendingReady || stopped || document.hidden || socket?.readyState === WebSocket.OPEN) return;
    const report = pendingReady;
    pendingReady = null;
    reportingReady = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(`/api/ready?token=${encodeURIComponent(token)}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report), signal: controller.signal });
      if (!response.ok && response.status !== 409) throw new Error();
    } catch { pendingReady ??= report; }
    finally { clearTimeout(timeout); reportingReady = false; }
  }

  function accept(state) {
    if (sessionId && sessionId !== state.sessionId) lastRevision = -1;
    sessionId = state.sessionId;
    if (state.revision < lastRevision) return;
    lastRevision = state.revision;
    onState(state);
  }

  async function refresh() {
    if (polling || stopped) return;
    polling = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(stateUrl, { headers, cache: 'no-store', signal: controller.signal });
      if (!response.ok) {
        const body = await response.json();
        if (response.status === 401 || response.status === 403) {
          stop();
          onError(body.error);
          return;
        }
        throw new Error(body.error);
      }
      accept(await response.json());
      if (socket?.readyState !== WebSocket.OPEN) onConnection('polling');
    } catch {
      if (!stopped) onConnection('offline');
    } finally {
      clearTimeout(timer);
      polling = false;
    }
  }

  function connect() {
    if (stopped || document.hidden || reconnectTimer || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
    onConnection('connecting');
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?role=${role}&token=${encodeURIComponent(token)}`);
    const current = socket;
    const timeout = setTimeout(() => current.close(), 7000);
    current.onopen = () => {
      clearTimeout(timeout);
      retry = 500;
      lastMessage = Date.now();
      onConnection('live');
      onOpen?.();
    };
    current.onmessage = (event) => {
      lastMessage = Date.now();
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'state') accept(message);
      } catch {}
    };
    current.onerror = () => {};
    current.onclose = () => {
      clearTimeout(timeout);
      if (socket !== current) return;
      socket = null;
      if (stopped) return;
      pendingReady ??= latestReady;
      void flushReady();
      onConnection('offline');
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, retry + Math.random() * 250);
      retry = Math.min(retry * 2, 10_000);
    };
  }

  async function resume() {
    if (document.hidden || stopped) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    socket?.close();
    socket = null;
    await refresh();
    pendingReady ??= latestReady;
    connect();
    void flushReady();
  }

  function stop() {
    stopped = true;
    clearTimeout(reconnectTimer);
    clearInterval(watchdog);
    socket?.close();
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('pageshow', resume);
    window.removeEventListener('online', resume);
  }

  const watchdog = setInterval(() => {
    if (stopped || document.hidden) return;
    if (socket?.readyState !== WebSocket.OPEN || Date.now() - lastMessage > 15_000) void refresh();
    if (socket?.readyState === WebSocket.OPEN && Date.now() - lastMessage > 22_000) socket.close();
    connect();
    void flushReady();
  }, 3000);
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('pageshow', resume);
  window.addEventListener('online', resume);

  return {
    async start() { await refresh(); connect(); },
    refresh,
    stop,
    send(message) {
      if (message.type === 'ready') latestReady = message;
      if (socket?.readyState === WebSocket.OPEN) {
        if (message.type === 'ready') pendingReady = null;
        socket.send(JSON.stringify(message));
      } else if (role === 'viewer' && message.type === 'ready') {
        pendingReady = message;
        void flushReady();
      }
    },
  };
}

export function connectionLabel(element, status) {
  element.textContent = { live: 'Синхронізовано', polling: 'Резервний зв’язок', offline: 'Відновлюємо зв’язок…', connecting: 'Підключення…' }[status];
  element.dataset.status = status;
}

export function setupFullscreen(button, target, onError) {
  button.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (target.requestFullscreen) await target.requestFullscreen();
      else onError('На цьому пристрої поверніть телефон горизонтально. Повноекранний режим браузера недоступний.');
    } catch { onError('Не вдалося розгорнути показ. Поверніть телефон горизонтально.'); }
  });
}
