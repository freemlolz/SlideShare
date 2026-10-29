import { createSync, takeToken, connectionLabel, setupFullscreen } from './sync.js';
import { createSlides } from './slides.js';

const element = (id) => document.getElementById(id);
const token = takeToken('host');
const headers = { 'X-Host-Token': token };
let state;
let links = [];
let changing = false;
let uploading = false;
function showError(message) { element('error').textContent = message; element('error').hidden = false; }
const slides = createSlides({ image: element('slide-image'), empty: element('empty'), headers, onError: showError });

function update(nextState) {
  if (state?.sessionId === nextState.sessionId && nextState.revision < state.revision) return;
  state = nextState;
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
setupFullscreen(element('fullscreen'), element('stage'), showError);
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
