import { parentPort, workerData } from 'node:worker_threads';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';

Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
const require = createRequire(import.meta.url);
const pdfRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
const { getDocument, AnnotationMode } = await import('pdfjs-dist/legacy/build/pdf.mjs');

try {
  const bytes = await readFile(workerData.input);
  const task = getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
    cMapUrl: `${pdfRoot}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${pdfRoot}/standard_fonts/`,
    wasmUrl: `${pdfRoot}/wasm/`,
    verbosity: 0,
  });
  const document = await task.promise;
  try {
    if (document.numPages > workerData.maxPages) {
      throw new Error(`PDF має понад ${workerData.maxPages} слайдів.`);
    }
    await mkdir(workerData.output, { recursive: true });
    const pages = [];
    let totalBytes = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const original = page.getViewport({ scale: 1 });
      if (!Number.isFinite(original.width) || !Number.isFinite(original.height)
        || original.width <= 0 || original.height <= 0) {
        throw new Error('PDF містить сторінку з некоректним розміром.');
      }
      const scale = 1600 / Math.max(original.width, original.height);
      const viewport = page.getViewport({ scale });
      const width = Math.max(1, Math.ceil(viewport.width));
      const height = Math.max(1, Math.ceil(viewport.height));
      const canvas = createCanvas(width, height);
      await page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
        background: 'rgb(255,255,255)',
        annotationMode: AnnotationMode.ENABLE,
      }).promise;
      const image = await canvas.encode('jpeg', 85);
      totalBytes += image.length;
      if (totalBytes > workerData.maxImageBytes) {
        throw new Error('Зображення займають понад 48 МіБ. Зменште PDF або розділіть презентацію.');
      }
      await writeFile(path.join(workerData.output, `${pageNumber}.jpg`), image);
      pages.push({ width, height, bytes: image.length });
      canvas.width = 1;
      canvas.height = 1;
      page.cleanup();
      parentPort.postMessage({ type: 'progress', done: pageNumber, total: document.numPages });
    }
    parentPort.postMessage({ type: 'done', pages, totalBytes });
  } finally {
    await task.destroy();
  }
} catch (error) {
  const message = error.name === 'PasswordException'
    ? 'PDF захищений паролем. Експортуйте копію без пароля.'
    : error.name === 'InvalidPDFException'
      ? 'Не вдалося прочитати PDF. Перевірте файл або експортуйте його повторно.'
      : error.message;
  parentPort.postMessage({ type: 'error', message });
}
