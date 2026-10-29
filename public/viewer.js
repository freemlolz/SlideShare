import { createSync, takeToken, connectionLabel, setupFullscreen } from './sync.js';
import { createSlides } from './slides.js';

const element = (id) => document.getElementById(id);
const token = takeToken('viewer');
let lastReport;
let sync;
function showError(message) { element('error').textContent = message; element('error').hidden = false; }
const slides = createSlides({
  image: element('slide-image'), empty: element('empty'), token, onError: showError,
  onProgress(loaded, total, deckId) {
    element('preload').textContent = total
      ? loaded === total ? `Усі ${total} слайдів завантажено` : `Завантажено ${loaded} / ${total} слайдів`
      : 'Слайди завантажаться заздалегідь';
    const report = `${deckId}:${loaded}`;
    if (report !== lastReport) {
      lastReport = report;
      sync?.send({ type: 'ready', deckId, loaded });
    }
  },
});

sync = createSync({ role: 'viewer', token,
  onState(state) {
    element('page-label').textContent = state.deck ? `Слайд ${state.slide + 1} / ${state.deck.pages.length}` : 'Очікуємо презентацію';
    slides.update(state);
  },
  onConnection(status) { connectionLabel(element('connection'), status); },
  onError: showError,
  onOpen() { lastReport = null; slides.report(); },
});
setupFullscreen(element('fullscreen'), document.documentElement, showError);
document.addEventListener('visibilitychange', () => { if (!document.hidden) slides.resume(); });
if (!token) {
  sync.stop();
  element('empty').textContent = 'Відскануйте QR-код на екрані ведучого.';
  showError('Потрібне повне посилання з QR-коду.');
} else await sync.start();
