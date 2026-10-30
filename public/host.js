import { createSync, takeToken, connectionLabel, setupFullscreen } from './sync.js';
import { createSlides } from './slides.js';
import { createAnnotations } from './annotations.js';

const element = (id) => document.getElementById(id);
const token = takeToken('host');
const headers = { 'X-Host-Token': token };
let state;
let links = [];
let changing = false;
let uploading = false;
let drawingEnabled = false;
let drawingTimer;
let drawingSending = false;
const pendingStrokes = new Map();
function showError(message) { element('error').textContent = message; element('error').hidden = false; }
const annotations = createAnnotations({
  canvas: element('annotations'), image: element('slide-image'), onError: showError,
  settings: () => ({ tool: element('draw-tool').value, size: Number(element('draw-size').value),
    color: element('draw-color').value, lifetime: Number(element('draw-lifetime').value) }),
  onStroke(stroke, finished) {
    const pending = pendingStrokes.get(stroke.id) ?? { stroke, sent: 0, finished: false };
    pending.finished ||= finished;
    pendingStrokes.set(stroke.id, pending);
    scheduleDrawing();
  },
});
const slides = createSlides({ image: element('slide-image'), empty: element('empty'), headers,
  onError: showError, onDisplay: annotations.refresh });

function currentStroke(stroke) {
  return state?.deck?.id === stroke.deckId && state.slide === stroke.index && state.annotations?.epoch === stroke.epoch;
}

function scheduleDrawing() {
  if (!drawingTimer && !drawingSending) drawingTimer = setTimeout(() => { drawingTimer = null; void flushDrawing(); }, 80);
}

async function flushDrawing() {
  if (drawingSending) return;
  const pending = [...pendingStrokes.values()].find((entry) => entry.sent < entry.stroke.points.length || entry.finished);
  if (!pending) return;
  const { stroke } = pending;
  if (!currentStroke(stroke)) { pendingStrokes.delete(stroke.id); scheduleDrawing(); return; }
  const points = stroke.points.slice(pending.sent, pending.sent + 32);
  const finished = pending.finished && pending.sent + points.length === stroke.points.length;
  drawingSending = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const nextState = await api('/api/host/annotations', { method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deckId: stroke.deckId, index: stroke.index, epoch: stroke.epoch,
        action: 'append', id: stroke.id, tool: stroke.tool, size: stroke.size, color: stroke.color,
        lifetime: stroke.lifetime, points, finished }) });
    pending.sent += points.length;
    if (finished) pendingStrokes.delete(stroke.id);
    update(nextState);
  } catch (error) {
    pendingStrokes.delete(stroke.id);
    if (currentStroke(stroke)) annotations.reject(stroke.id, error.name === 'AbortError'
      ? 'Не вдалося передати малюнок. Перевірте з’єднання.' : error.message);
  } finally {
    clearTimeout(timeout);
    drawingSending = false;
    if (pendingStrokes.size) scheduleDrawing();
  }
}

function update(nextState) {
  if (state?.sessionId === nextState.sessionId && nextState.revision < state.revision) return;
  if (state?.deck?.id !== nextState.deck?.id || state?.slide !== nextState.slide
    || state?.annotations?.epoch !== nextState.annotations?.epoch) pendingStrokes.clear();
  state = nextState;
  annotations.update(state);
  slides.update(state);
  const count = state.deck?.pages.length ?? 0;
  element('page-total').textContent = `/ ${count}`;
  if (document.activeElement !== element('slide-number')) element('slide-number').value = state.slide + 1;
  element('slide-number').max = count;
  element('slide-number').disabled = !count;
  element('previous').disabled = !count || state.slide === 0 || changing;
  element('next').disabled = !count || state.slide === count - 1 || changing;
  element('participants').textContent = state.participants;
  element('ready').textContent = state.ready;
  element('deck-name').textContent = state.deck ? `${state.deck.name} · ${(state.deck.totalBytes / 1024 / 1024).toFixed(1)} МіБ для учасника` : 'PDF ще не завантажено';
  element('upload-progress').textContent = state.processing
    ? `Готуємо слайди: ${state.processing.done} / ${state.processing.total ?? '…'}. Поточна презентація залишається доступною.`
    : uploading ? 'Передаємо PDF на локальний сервер…' : state.deck ? 'Презентація готова. Учасники завантажують слайди автоматично.' : '';
  element('upload').disabled = uploading || Boolean(state.processing);
  for (const id of ['draw-toggle', 'draw-tool', 'draw-size', 'draw-color', 'draw-lifetime', 'draw-clear']) {
    element(id).disabled = !count;
  }
}

const sync = createSync({ role: 'host', token, onState: update,
  onConnection: (status) => connectionLabel(element('connection'), status), onError: showError });

async function api(url, options) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...options?.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  return body;
}

async function changeSlide(index) {
  if (changing || !state?.deck || index < 0 || index >= state.deck.pages.length || !Number.isInteger(index)) return;
  changing = true;
  update(state);
  try {
    update(await api('/api/host/slide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deckId: state.deck.id, index }) }));
  } catch (error) { showError(error.message); }
  finally { changing = false; update(state); }
}

function selectLink() {
  const link = links[Number(element('network').value)];
  if (!link) return;
  element('qr').src = link.qr;
  element('qr').hidden = false;
  element('join-url').href = link.url;
  element('join-url').textContent = link.url.split('#')[0];
}

element('network').addEventListener('change', selectLink);
element('copy').addEventListener('click', async () => {
  const link = links[Number(element('network').value)];
  if (!link) return;
  try { await navigator.clipboard.writeText(link.url); element('copy-status').textContent = 'Посилання скопійовано'; }
  catch { showError('Копіювання недоступне. Відскануйте QR або скопіюйте адресу посилання через меню браузера.'); }
});
element('previous').addEventListener('click', () => void changeSlide(state.slide - 1));
element('next').addEventListener('click', () => void changeSlide(state.slide + 1));
element('slide-number').addEventListener('change', () => void changeSlide(Number(element('slide-number').value) - 1));
document.addEventListener('keydown', (event) => {
  if (event.target.matches('input, select, button, textarea') || !state?.deck || event.altKey || event.ctrlKey || event.metaKey) return;
  if (['ArrowRight', ' ', 'PageDown', 'ArrowLeft', 'PageUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? state.deck.pages.length - 1
      : state.slide + (['ArrowLeft', 'PageUp'].includes(event.key) ? -1 : 1);
    void changeSlide(index);
  }
});
element('upload-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = element('pdf').files[0];
  if (!file || uploading) return;
  if (file.size > 40 * 1024 * 1024) { showError('PDF перевищує 40 МіБ.'); return; }
  uploading = true;
  element('error').hidden = true;
  if (state) update(state);
  const body = new FormData();
  body.append('pdf', file);
  try { update(await api('/api/host/pdf', { method: 'POST', body })); }
  catch (error) { showError(error.message); }
  finally { uploading = false; if (state) update(state); }
});
element('draw-toggle').addEventListener('click', () => {
  drawingEnabled = !drawingEnabled;
  element('draw-toggle').setAttribute('aria-pressed', String(drawingEnabled));
  annotations.setEnabled(drawingEnabled);
});
element('draw-clear').addEventListener('click', async () => {
  if (!state?.deck) return;
  pendingStrokes.clear();
  try {
    update(await api('/api/host/annotations', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'clear', deckId: state.deck.id, index: state.slide, epoch: state.annotations.epoch }) }));
  } catch (error) { showError(error.message); }
});
setupFullscreen(element('fullscreen'), element('presentation-screen'), showError);
if (!token) showError('Відкрийте повне посилання ведучого з термінала на цьому ноутбуці.');
else {
  await sync.start();
  try {
    ({ links } = await api('/api/host/config'));
    for (const [index, link] of links.entries()) {
      const option = document.createElement('option');
      option.value = index;
      option.textContent = link.address;
      element('network').append(option);
    }
    if (!links.length) showError('Активну IPv4-мережу не знайдено. Підключіть Wi-Fi та перезапустіть сервер.');
    selectLink();
  } catch (error) { showError(error.message); }
}
