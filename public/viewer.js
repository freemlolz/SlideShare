import { createSync, takeToken, connectionLabel, setupFullscreen } from './sync.js';
import { createSlides } from './slides.js';
import { createAnnotations } from './annotations.js';

const element = (id) => document.getElementById(id);
const token = takeToken('viewer');
let lastReport;
let sync;
let state;
let browsing = null;
let furthestSlide = 0;
function showError(message) { element('error').textContent = message; element('error').hidden = false; }
const annotations = createAnnotations({ canvas: element('annotations'), image: element('slide-image') });
const slides = createSlides({
  image: element('slide-image'), empty: element('empty'), token, onError: showError,
  onDisplay: annotations.refresh,
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

function render() {
  const index = browsing ?? state.slide;
  const count = state.deck?.pages.length ?? 0;
  element('page-label').textContent = count ? `Слайд ${index + 1} / ${count}` : 'Очікуємо презентацію';
  element('viewer-previous').disabled = !count || index === 0;
  element('viewer-next').disabled = !count || index >= furthestSlide;
  element('go-live').disabled = !count || browsing === null;
  element('follow-status').textContent = browsing === null ? 'Разом із ведучим'
    : `Перегляд історії · ведучий: ${state.slide + 1}`;
  annotations.update(state);
  slides.update({ ...state, slide: index });
}

sync = createSync({ role: 'viewer', token,
  onState(nextState) {
    if (state?.deck?.id !== nextState.deck?.id || state?.sessionId !== nextState.sessionId) {
      browsing = null;
      furthestSlide = 0;
    }
    state = nextState;
    furthestSlide = Math.max(furthestSlide, state.slide);
    render();
  },
  onConnection(status) { connectionLabel(element('connection'), status); },
  onError: showError,
  onOpen() { lastReport = null; slides.report(); },
});
element('viewer-previous').addEventListener('click', () => {
  if (!state?.deck) return;
  browsing = Math.max(0, (browsing ?? state.slide) - 1);
  render();
});
element('viewer-next').addEventListener('click', () => {
  if (!state?.deck) return;
  browsing = Math.min(furthestSlide, (browsing ?? state.slide) + 1);
  render();
});
element('go-live').addEventListener('click', () => { if (state) { browsing = null; render(); } });
setupFullscreen(element('fullscreen'), document.documentElement, showError);
document.addEventListener('visibilitychange', () => { if (!document.hidden) slides.resume(); });
if (!token) {
  sync.stop();
  element('empty').textContent = 'Відскануйте QR-код на екрані ведучого.';
  showError('Потрібне повне посилання з QR-коду.');
} else await sync.start();
