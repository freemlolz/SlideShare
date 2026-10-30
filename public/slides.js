export function createSlides({ image, empty, token, headers = {}, onProgress, onError, onDisplay }) {
  let deck;
  let currentIndex = 0;
  let displayedIndex = -1;
  let generation = 0;
  let displayRequest = 0;
  let controller = new AbortController();
  let preloadTimer;
  let preloadRunning = false;
  let lastErrorAt = 0;
  const cache = new Map();
  const pending = new Map();

  function progress() { onProgress?.(cache.size, deck?.pages.length ?? 0, deck?.id); }

  function reset(nextDeck) {
    generation += 1;
    displayRequest += 1;
    controller.abort();
    controller = new AbortController();
    clearTimeout(preloadTimer);
    for (const url of cache.values()) URL.revokeObjectURL(url);
    cache.clear();
    pending.clear();
    preloadRunning = false;
    displayedIndex = -1;
    image.hidden = true;
    image.removeAttribute('src');
    delete image.dataset.deckId;
    delete image.dataset.slideIndex;
    onDisplay?.();
    deck = nextDeck;
    empty.hidden = false;
    empty.textContent = deck ? 'Завантажуємо поточний слайд…' : 'Ведучий готує презентацію. Залишайте сторінку відкритою.';
    progress();
  }

  function load(index) {
    if (cache.has(index)) return Promise.resolve(cache.get(index));
    if (pending.has(index)) return pending.get(index);
    const requestGeneration = generation;
    const signal = controller.signal;
    const requestController = new AbortController();
    const abort = () => requestController.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 15_000);
    const url = `/slides/${deck.id}/${index + 1}.jpg${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    const promise = fetch(url, { headers, signal: requestController.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Слайд ще не завантажився. Повторюємо спробу…');
        const blob = await response.blob();
        if (requestGeneration !== generation) throw new DOMException('Презентація змінилася', 'AbortError');
        const objectUrl = URL.createObjectURL(blob);
        cache.set(index, objectUrl);
        progress();
        return objectUrl;
      }).finally(() => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        if (requestGeneration === generation) pending.delete(index);
      });
    pending.set(index, promise);
    return promise;
  }

  async function display(index) {
    if (!deck) return;
    const request = ++displayRequest;
    if (displayedIndex === index) return;
    const requestGeneration = generation;
    try {
      const url = await load(index);
      const decoded = new Image();
      decoded.src = url;
      await decoded.decode();
      if (request !== displayRequest || requestGeneration !== generation) return;
      image.src = url;
      image.hidden = false;
      empty.hidden = true;
      displayedIndex = index;
      image.dataset.deckId = deck.id;
      image.dataset.slideIndex = String(index);
      onDisplay?.();
    } catch (error) {
      if (requestGeneration !== generation || error.name === 'AbortError') return;
      if (Date.now() - lastErrorAt > 8000) {
        onError(error.message || 'Не вдалося показати слайд. Відновлюємо завантаження…');
        lastErrorAt = Date.now();
      }
    }
  }

  async function preload() {
    if (!deck || preloadRunning || document.hidden) return;
    preloadRunning = true;
    const requestGeneration = generation;
    let failed = false;
    try {
      while (requestGeneration === generation) {
        const order = [currentIndex, currentIndex + 1, currentIndex - 1,
          ...deck.pages.map((page, index) => index)];
        const batch = [...new Set(order)].filter((index) => index >= 0 && index < deck.pages.length && !cache.has(index)).slice(0, 2);
        if (!batch.length) break;
        const results = await Promise.allSettled(batch.map(load));
        if (results.some((result) => result.status === 'rejected')) { failed = true; break; }
        if (document.hidden) break;
      }
    } finally {
      if (requestGeneration === generation) {
        preloadRunning = false;
        if (failed) preloadTimer = setTimeout(() => void preload(), 3000);
      }
    }
  }

  return {
    update(state) {
      if (state.deck?.id !== deck?.id) reset(state.deck);
      if (!state.deck) {
        if (!deck) empty.textContent = 'Ведучий готує презентацію. Залишайте сторінку відкритою.';
        return;
      }
      currentIndex = state.slide;
      void display(currentIndex);
      if (!preloadRunning && cache.size < deck.pages.length) {
        clearTimeout(preloadTimer);
        preloadTimer = setTimeout(() => void preload(), 350);
      }
    },
    resume() { if (deck) { void display(currentIndex); void preload(); } },
    report: progress,
  };
}
