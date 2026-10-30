const FADE_MS = 1000;
const CLEAR_FADE_MS = 250;

export function inkOpacity(stroke, now) {
  let remaining;
  if (stroke.fadeEndsAt !== undefined) {
    remaining = (stroke.fadeEndsAt - now) / Math.max(1, stroke.fadeEndsAt - stroke.fadeStartedAt);
  } else if (stroke.finished && stroke.lifetime > 0 && stroke.expiresAt !== null) {
    remaining = (stroke.expiresAt - now) / FADE_MS;
  } else return 1;
  const progress = Math.max(0, Math.min(1, remaining));
  return (stroke.fadeFromOpacity ?? 1) * progress * progress * (3 - 2 * progress);
}

export function createAnnotations({ canvas, image, onStroke, onError, settings }) {
  const context = canvas.getContext('2d');
  let state;
  let enabled = false;
  let draft;
  let pointerId;
  let expiryTimer;
  let frameRequest;
  let clockOffset = 0;
  const local = new Map();
  const fading = new Map();

  function imageBounds() {
    const rectangle = canvas.getBoundingClientRect();
    const scale = Math.min(rectangle.width / image.naturalWidth, rectangle.height / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    return { rectangle, width, height, left: (rectangle.width - width) / 2, top: (rectangle.height - height) / 2 };
  }

  function activeSlide() {
    return state?.deck && !image.hidden && image.dataset.deckId === state.deck.id
      && Number(image.dataset.slideIndex) === state.slide;
  }

  function paintStroke(stroke, bounds, opacity) {
    const points = stroke.points;
    if (!points.length) return;
    const width = stroke.size * Math.max(bounds.width, bounds.height) / 1600;
    context.strokeStyle = stroke.color;
    context.fillStyle = stroke.color;
    context.globalAlpha = (stroke.tool === 'marker' ? 0.3 : 1) * opacity;
    context.lineCap = stroke.tool === 'marker' ? 'butt' : 'round';
    context.lineJoin = 'round';
    const pointWidth = (point) => width * (stroke.tool === 'marker' ? 2.2 : stroke.tool === 'pencil' ? 0.65 : 0.4 + point[2]);
    if (points.length === 1) {
      context.beginPath();
      context.arc(points[0][0] * bounds.width, points[0][1] * bounds.height, pointWidth(points[0]) / 2, 0, Math.PI * 2);
      context.fill();
    } else if (stroke.tool === 'brush') {
      for (let index = 1; index < points.length; index += 1) {
        context.beginPath();
        context.lineWidth = (pointWidth(points[index - 1]) + pointWidth(points[index])) / 2;
        context.moveTo(points[index - 1][0] * bounds.width, points[index - 1][1] * bounds.height);
        context.lineTo(points[index][0] * bounds.width, points[index][1] * bounds.height);
        context.stroke();
      }
    } else {
      context.beginPath();
      context.lineWidth = pointWidth(points[0]);
      context.moveTo(points[0][0] * bounds.width, points[0][1] * bounds.height);
      for (const point of points.slice(1)) context.lineTo(point[0] * bounds.width, point[1] * bounds.height);
      context.stroke();
    }
    context.globalAlpha = 1;
  }

  function render() {
    frameRequest = null;
    clearTimeout(expiryTimer);
    const bounds = imageBounds();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(bounds.rectangle.width * ratio));
    const height = Math.max(1, Math.round(bounds.rectangle.height * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, bounds.rectangle.width, bounds.rectangle.height);
    canvas.dataset.strokeCount = '0';
    if (!activeSlide()) return;
    const strokes = new Map((state.annotations?.strokes ?? []).map((stroke) => [stroke.id, stroke]));
    for (const [id, stroke] of local) strokes.set(id, stroke);
    const now = Date.now() + clockOffset;
    for (const [id, stroke] of fading) {
      if (stroke.fadeEndsAt <= now) fading.delete(id);
      else if (!strokes.has(id)) strokes.set(id, stroke);
    }
    const visible = [...strokes.values()].filter((stroke) => (stroke.expiresAt === null || stroke.expiresAt > now)
      && inkOpacity(stroke, now) > 0);
    canvas.dataset.strokeCount = String(visible.length);
    context.save();
    context.translate(bounds.left, bounds.top);
    context.beginPath();
    context.rect(0, 0, bounds.width, bounds.height);
    context.clip();
    for (const stroke of visible) paintStroke(stroke, bounds, inkOpacity(stroke, now));
    context.restore();
    const animating = visible.some((stroke) => stroke.fadeEndsAt !== undefined
      || (stroke.finished && stroke.lifetime > 0 && stroke.expiresAt - now <= FADE_MS));
    const deadlines = visible.map((stroke) => stroke.expiresAt === null ? null
      : stroke.finished && stroke.lifetime > 0 ? stroke.expiresAt - FADE_MS : stroke.expiresAt)
      .filter((value) => value !== null && value > now);
    if (animating) refresh();
    else if (deadlines.length) expiryTimer = setTimeout(refresh, Math.max(1, Math.min(...deadlines) - now));
  }

  function refresh() { if (!frameRequest) frameRequest = requestAnimationFrame(render); }

  function cancelDraft() {
    const captured = pointerId;
    draft = null;
    pointerId = undefined;
    local.clear();
    if (captured !== undefined && canvas.hasPointerCapture(captured)) canvas.releasePointerCapture(captured);
  }

  function position(event, clamp = false) {
    const bounds = imageBounds();
    const horizontal = (event.clientX - bounds.rectangle.left - bounds.left) / bounds.width;
    const vertical = (event.clientY - bounds.rectangle.top - bounds.top) / bounds.height;
    if (!Number.isFinite(horizontal) || !Number.isFinite(vertical)
      || (!clamp && (horizontal < 0 || horizontal > 1 || vertical < 0 || vertical > 1))) return null;
    return [Number(Math.max(0, Math.min(1, horizontal)).toFixed(4)),
      Number(Math.max(0, Math.min(1, vertical)).toFixed(4)),
      Number((event.pointerType === 'pen' ? Math.max(0.05, event.pressure) : 0.6).toFixed(3))];
  }

  function changed(finished) {
    onStroke?.(draft, finished);
    refresh();
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (!enabled || !activeSlide() || draft || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const point = position(event);
    if (!point) return;
    event.preventDefault();
    pointerId = event.pointerId;
    canvas.setPointerCapture(pointerId);
    draft = { id: crypto.randomUUID(), ...settings(), points: [point], expiresAt: null,
      deckId: state.deck.id, index: state.slide, epoch: state.annotations.epoch };
    local.set(draft.id, draft);
    changed(false);
  });

  function finish(event) {
    if (!draft || event.pointerId !== pointerId) return;
    const completed = draft;
    draft = null;
    if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    pointerId = undefined;
    completed.expiresAt = completed.lifetime ? Date.now() + clockOffset + completed.lifetime : null;
    onStroke?.(completed, true);
    refresh();
  }

  canvas.addEventListener('pointermove', (event) => {
    if (!draft || event.pointerId !== pointerId) return;
    event.preventDefault();
    const point = position(event, true);
    const previous = draft.points.at(-1);
    if (point && Math.hypot(point[0] - previous[0], point[1] - previous[1]) >= 0.001) {
      draft.points.push(point);
      changed(false);
      if (draft.points.length >= 1400) finish(event);
    }
  });
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  canvas.addEventListener('lostpointercapture', finish);
  new ResizeObserver(refresh).observe(canvas);

  return {
    update(nextState) {
      const changedSlide = state?.sessionId !== nextState.sessionId || state?.deck?.id !== nextState.deck?.id
        || state?.slide !== nextState.slide;
      const cleared = state?.annotations?.epoch !== nextState.annotations?.epoch;
      if (changedSlide) fading.clear();
      else if (cleared) {
        const strokes = new Map((state.annotations?.strokes ?? []).map((stroke) => [stroke.id, stroke]));
        for (const [id, stroke] of local) strokes.set(id, stroke);
        const now = nextState.serverTime;
        for (const [id, stroke] of strokes) {
          const opacity = inkOpacity(stroke, now);
          const duration = Math.min(CLEAR_FADE_MS, (stroke.expiresAt ?? Infinity) - now);
          if (opacity > 0 && duration > 0) fading.set(id, { ...stroke, points: stroke.points.slice(),
            fadeStartedAt: now, fadeEndsAt: now + duration, fadeFromOpacity: opacity });
        }
      }
      if (changedSlide || cleared) cancelDraft();
      state = nextState;
      clockOffset = state.serverTime - Date.now();
      for (const stroke of state.annotations?.strokes ?? []) if (stroke.finished) local.delete(stroke.id);
      refresh();
    },
    setEnabled(value) {
      enabled = value;
      canvas.classList.toggle('drawing-enabled', value);
      if (!value && draft) finish({ pointerId });
    },
    reject(id, error) { local.delete(id); if (draft?.id === id) cancelDraft(); refresh(); onError?.(error); },
    refresh,
  };
}
