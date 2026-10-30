const MAX_STROKES = 64;
const MAX_POINTS = 6000;
const MAX_STROKE_POINTS = 1500;

function invalid(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

export class AnnotationLayer {
  constructor(onChange) {
    this.onChange = onChange;
    this.epoch = 0;
    this.strokes = new Map();
    this.timer = null;
  }

  snapshot() {
    return { epoch: this.epoch, strokes: [...this.strokes.values()] };
  }

  reset() {
    clearTimeout(this.timer);
    this.strokes.clear();
    this.epoch += 1;
  }

  apply(message) {
    if (message?.epoch !== this.epoch) invalid('Малюнки вже очищено або слайд змінився.', 409);
    if (message.action === 'clear') { this.reset(); return; }
    if (message.action !== 'append') invalid('Невідома дія малювання.');
    const { id, points, finished } = message;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)
      || !Array.isArray(points) || points.length > 32 || typeof finished !== 'boolean'
      || points.some((point) => !Array.isArray(point) || point.length !== 3
        || point.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1))) {
      invalid('Некоректні координати малювання.');
    }
    let stroke = this.strokes.get(id);
    if (stroke?.finished) invalid('Цю лінію вже завершено.', 409);
    if (!stroke) {
      const { tool, size, color, lifetime } = message;
      if (!['pencil', 'brush', 'marker'].includes(tool)
        || !Number.isInteger(size) || size < 1 || size > 32
        || typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)
        || ![0, 5000].includes(lifetime) || points.length === 0) invalid('Некоректні налаштування інструмента.');
      if (this.strokes.size >= MAX_STROKES) invalid('Забагато ліній. Очистіть малюнки й продовжуйте.', 413);
      stroke = { id, tool, size, color, lifetime, points: [], finished: false, expiresAt: null };
    }
    const pointCount = [...this.strokes.values()].reduce((total, entry) => total + entry.points.length, 0);
    if (pointCount + points.length > MAX_POINTS || stroke.points.length + points.length > MAX_STROKE_POINTS) {
      invalid('Малюнок завеликий. Очистіть малюнки або почніть коротшу лінію.', 413);
    }
    stroke.points.push(...points);
    stroke.finished = finished;
    stroke.expiresAt = finished ? (stroke.lifetime ? Date.now() + stroke.lifetime : null) : Date.now() + 30_000;
    this.strokes.set(id, stroke);
    this.scheduleExpiry();
  }

  scheduleExpiry() {
    clearTimeout(this.timer);
    const deadlines = [...this.strokes.values()].map((stroke) => stroke.expiresAt).filter((value) => value !== null);
    if (!deadlines.length) return;
    this.timer = setTimeout(() => {
      const now = Date.now();
      for (const [id, stroke] of this.strokes) {
        if (stroke.expiresAt !== null && stroke.expiresAt <= now) this.strokes.delete(id);
      }
      this.scheduleExpiry();
      this.onChange();
    }, Math.max(1, Math.min(...deadlines) - Date.now()));
    this.timer.unref();
  }

  close() { clearTimeout(this.timer); }
}
