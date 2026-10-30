import http from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, mkdir, open, rm } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import { WebSocketServer, WebSocket } from 'ws';
import { AnnotationLayer } from './annotations.mjs';
import { PollSession } from './polls.mjs';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
export const LIMITS = { pdfBytes: 40 * 1024 * 1024, pages: 150, imageBytes: 48 * 1024 * 1024, renderMs: 120_000 };

export function localAddresses() {
  return [...new Set(Object.values(networkInterfaces()).flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address))];
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function sameSecret(value, expected) {
  if (typeof value !== 'string') return false;
  const actualBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function errorWithStatus(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export async function createSlideSync({ port = 3000, host = '0.0.0.0', lanAddress, renderMs = LIMITS.renderMs } = {}) {
  const addresses = localAddresses();
  if (lanAddress && !addresses.includes(lanAddress)) {
    throw new Error('LAN_ADDRESS має бути IPv4-адресою активного інтерфейсу цього ноутбука.');
  }
  const storage = await mkdtemp(path.join(tmpdir(), 'slidesync-'));
  await mkdir(path.join(storage, 'uploads'));
  const sessionId = randomBytes(12).toString('hex');
  const hostToken = randomBytes(24).toString('hex');
  const viewerToken = randomBytes(24).toString('hex');
  const app = express();
  app.disable('x-powered-by');
  const server = http.createServer(app);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
  let deck = null;
  let slide = 0;
  let revision = 0;
  let processing = null;
  let busy = false;
  let closing = false;
  let activeWorker = null;
  let activeUpload = null;
  let actualPort;
  const annotations = new AnnotationLayer(broadcast);
  const polls = new PollSession(broadcast);
  const voterCookie = `slidesync-voter-${sessionId}`;

  function snapshot(voterId) {
    const viewers = [...sockets.clients].filter((client) => client.role === 'viewer' && client.readyState === WebSocket.OPEN);
    return {
      type: 'state', sessionId, revision, slide, deck, processing,
      serverTime: Date.now(), annotations: annotations.snapshot(),
      poll: polls.snapshot(voterId),
      participants: viewers.length,
      ready: viewers.filter((client) => deck && client.deckId === deck.id && client.loaded === deck.pages.length).length,
    };
  }

  function send(client, payload) {
    if (client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > 1024 * 1024) client.terminate();
    else client.send(JSON.stringify(payload));
  }

  function broadcast() {
    revision += 1;
    const state = snapshot();
    for (const client of sockets.clients) send(client, { ...state, poll: polls.snapshot(client.voterId) });
  }

  function allowedHost(request) {
    try {
      const hostname = new URL(`http://${request.headers.host}`).hostname;
      return ['localhost', '127.0.0.1', '[::1]', ...addresses].includes(hostname);
    } catch {
      return false;
    }
  }

  function sameOrigin(request) {
    return !request.headers.origin || request.headers.origin === `http://${request.headers.host}`;
  }

  function authorizedHost(request) {
    return isLoopback(request.socket.remoteAddress)
      && sameSecret(request.headers['x-host-token'], hostToken);
  }

  function authorizeHost(request, response, next) {
    if (!authorizedHost(request)) return response.status(403).json({ error: 'Керування доступне лише на ноутбуці з ключем ведучого.' });
    next();
  }

  function authorizeViewer(request, response, next) {
    if (authorizedHost(request)) return next();
    if (sameSecret(request.query.token, viewerToken)) {
      request.voterId = voterIdentity(request, response);
      return next();
    }
    response.status(401).json({ error: 'Сесію не знайдено. Відскануйте актуальний QR-код.' });
  }

  function voterIdentity(request, response) {
    const cookie = request.headers.cookie?.split(';').map((part) => part.trim())
      .find((part) => part.startsWith(`${voterCookie}=`))?.slice(voterCookie.length + 1);
    const sign = (identity) => createHmac('sha256', hostToken).update(identity).digest('hex');
    if (cookie && /^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(cookie)) {
      const [identity, signature] = cookie.split('.');
      if (sameSecret(signature, sign(identity))) return identity;
    }
    if (!response) return null;
    const identity = randomBytes(16).toString('hex');
    response.cookie(voterCookie, `${identity}.${sign(identity)}`, { httpOnly: true, sameSite: 'strict', path: '/' });
    return identity;
  }

  app.use((request, response, next) => {
    response.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' ws:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'Cache-Control': 'no-store',
    });
    if (!allowedHost(request) || !sameOrigin(request)) return response.status(403).json({ error: 'Недозволене джерело запиту.' });
    next();
  });
  app.use(express.json({ limit: '4kb' }));
  app.get('/', (request, response) => response.redirect(isLoopback(request.socket.remoteAddress) ? '/host' : '/join'));
  app.get('/host', (request, response) => {
    if (!isLoopback(request.socket.remoteAddress)) return response.sendStatus(403);
    response.sendFile(path.join(publicRoot, 'host.html'));
  });
  app.get('/join', (request, response) => response.sendFile(path.join(publicRoot, 'viewer.html')));
  app.use('/assets', express.static(publicRoot, { index: false, dotfiles: 'deny', maxAge: 0 }));
  app.get('/api/state', authorizeViewer, (request, response) => response.json(snapshot(request.voterId)));
  app.get('/api/host/config', authorizeHost, async (request, response) => {
    const sorted = lanAddress ? [lanAddress, ...addresses.filter((address) => address !== lanAddress)] : addresses;
    const links = await Promise.all(sorted.map(async (address) => {
      const url = `http://${address}:${actualPort}/join#token=${viewerToken}`;
      return { address, url, qr: await QRCode.toDataURL(url, { width: 280, margin: 2, errorCorrectionLevel: 'M' }) };
    }));
    response.json({ links, limits: LIMITS });
  });

  const upload = multer({ dest: path.join(storage, 'uploads'), limits: { fileSize: LIMITS.pdfBytes, files: 1, fields: 0, parts: 1 } }).single('pdf');

  function renderPdf(input, output) {
    return new Promise((resolve, reject) => {
      let result;
      let failure;
      const worker = new Worker(new URL('./pdf-worker.mjs', import.meta.url), {
        workerData: { input, output, maxPages: LIMITS.pages, maxImageBytes: LIMITS.imageBytes },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
      activeWorker = worker;
      const timer = setTimeout(() => {
        failure = errorWithStatus('Підготовка триває понад 120 секунд. Спробуйте менший PDF.', 422);
        void worker.terminate();
      }, renderMs);
      const finish = () => {
        clearTimeout(timer);
        if (activeWorker === worker) activeWorker = null;
        if (failure || !result) reject(failure ?? errorWithStatus('Підготовку PDF перервано.', 422));
        else resolve(result);
      };
      worker.on('message', (message) => {
        if (message.type === 'progress') {
          processing = { done: message.done, total: message.total };
          broadcast();
        }
        if (message.type === 'done') result = message;
        if (message.type === 'error') failure = errorWithStatus(message.message, 422);
      });
      worker.once('error', (error) => { failure = errorWithStatus(`Не вдалося підготувати PDF: ${error.message}`, 422); });
      worker.once('exit', finish);
    });
  }

  app.post('/api/host/pdf', authorizeHost, (request, response, next) => {
    if (busy || closing) return response.status(409).json({ error: 'Зачекайте завершення поточної підготовки.' });
    busy = true;
    activeUpload = new Promise((resolveUpload) => {
      upload(request, response, async (uploadError) => {
        let jobRoot;
        let previousRoot;
        let requestError;
        try {
          if (uploadError) throw uploadError;
          if (!request.file) throw errorWithStatus('Оберіть PDF-файл.');
          const input = await open(request.file.path, 'r');
          let signature;
          try {
            const buffer = Buffer.alloc(5);
            await input.read(buffer, 0, 5, 0);
            signature = buffer.toString();
          } finally { await input.close(); }
          if (signature !== '%PDF-') throw errorWithStatus('Файл не є PDF.');
          const id = randomBytes(12).toString('hex');
          jobRoot = path.join(storage, id);
          processing = { done: 0, total: null };
          broadcast();
          const result = await renderPdf(request.file.path, path.join(jobRoot, 'slides'));
          if (closing) throw errorWithStatus('Сервер зупиняється.', 503);
          const previous = deck;
          const fileName = Buffer.from(request.file.originalname, 'latin1').toString('utf8');
          deck = { id, name: fileName, pages: result.pages, totalBytes: result.totalBytes };
          slide = 0;
          annotations.reset();
          for (const client of sockets.clients) { client.loaded = 0; client.deckId = null; }
          processing = null;
          broadcast();
          if (previous) previousRoot = path.join(storage, previous.id);
          jobRoot = null;
        } catch (error) {
          requestError = error;
        } finally {
          processing = null;
          const cleanup = [];
          if (request.file) cleanup.push(rm(request.file.path, { force: true }));
          if (previousRoot) cleanup.push(rm(previousRoot, { recursive: true, force: true }));
          if (jobRoot) cleanup.push(rm(jobRoot, { recursive: true, force: true }));
          const results = await Promise.allSettled(cleanup);
          for (const result of results) if (result.status === 'rejected') console.error('Не вдалося прибрати тимчасовий файл:', result.reason);
          busy = false;
          broadcast();
          if (requestError) next(requestError);
          else response.json(snapshot());
          resolveUpload();
        }
      });
    });
  });

  app.post('/api/host/slide', authorizeHost, (request, response) => {
    if (!deck || request.body?.deckId !== deck.id) return response.status(409).json({ error: 'Презентація змінилася. Повторіть дію.' });
    const index = request.body.index;
    if (!Number.isInteger(index) || index < 0 || index >= deck.pages.length) return response.status(400).json({ error: 'Некоректний номер слайда.' });
    if (slide !== index) annotations.reset();
    slide = index;
    broadcast();
    response.json(snapshot());
  });

  app.post('/api/host/annotations', authorizeHost, (request, response) => {
    if (!deck || request.body?.deckId !== deck.id || request.body.index !== slide) {
      return response.status(409).json({ error: 'Слайд змінився. Малюйте на поточному слайді.' });
    }
    annotations.apply(request.body);
    broadcast();
    response.json(snapshot());
  });

  app.post('/api/host/polls/start', authorizeHost, (request, response) => {
    polls.start(request.body);
    broadcast();
    response.json(snapshot());
  });

  app.post('/api/host/polls/cancel', authorizeHost, (request, response) => {
    polls.cancel(request.body?.pollId);
    broadcast();
    response.json(snapshot());
  });

  app.post('/api/polls/vote', authorizeViewer, (request, response) => {
    if (!request.voterId) return response.status(403).json({ error: 'Голосування доступне учасникам через посилання з QR-коду.' });
    if (!voterIdentity(request)) return response.status(400).json({ error: 'Для голосування дозвольте cookie та оновіть сторінку.' });
    polls.vote(request.body, request.voterId);
    broadcast();
    response.json(snapshot(request.voterId));
  });

  app.get('/slides/:deckId/:page', authorizeViewer, (request, response) => {
    const match = /^(\d+)\.jpg$/.exec(request.params.page);
    const pageNumber = match ? Number(match[1]) : 0;
    if (!deck || request.params.deckId !== deck.id || pageNumber < 1 || pageNumber > deck.pages.length) return response.sendStatus(404);
    response.set('Cache-Control', 'private, max-age=86400, immutable');
    response.sendFile(path.join(storage, deck.id, 'slides', `${pageNumber}.jpg`));
  });

  app.use('/api', (request, response) => response.status(404).json({ error: 'API-маршрут не знайдено. Перезапустіть SlideSync Local та відкрийте нове посилання ведучого.' }));

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    const status = error instanceof multer.MulterError ? (error.code === 'LIMIT_FILE_SIZE' ? 413 : 400) : error.status ?? 500;
    const message = error.code === 'LIMIT_FILE_SIZE' ? 'PDF перевищує 40 МіБ.'
      : error instanceof multer.MulterError ? 'Надішліть один PDF у полі pdf без додаткових полів.'
        : status >= 500 ? 'Помилка сервера. Перевірте термінал і повторіть дію.' : error.message;
    if (status >= 500) console.error(error);
    response.status(status).json({ error: message });
  });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');
    const role = url.searchParams.get('role') === 'host' ? 'host' : 'viewer';
    const token = url.searchParams.get('token');
    const voterId = role === 'viewer' ? voterIdentity(request) : null;
    const authorized = role === 'host'
      ? isLoopback(request.socket.remoteAddress) && sameSecret(token, hostToken)
      : sameSecret(token, viewerToken) && Boolean(voterId);
    if (closing || url.pathname !== '/ws' || !allowedHost(request) || !sameOrigin(request) || !authorized) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => {
      client.role = role;
      client.voterId = voterId;
      client.alive = true;
      client.loaded = 0;
      client.on('error', () => {});
      client.on('pong', () => { client.alive = true; });
      client.on('message', (raw) => {
        try {
          const message = JSON.parse(raw.toString());
          if (role === 'viewer' && message.type === 'ready' && deck && message.deckId === deck.id
            && Number.isInteger(message.loaded) && message.loaded >= 0 && message.loaded <= deck.pages.length) {
            if (client.deckId !== deck.id || client.loaded !== message.loaded) {
              client.deckId = deck.id;
              client.loaded = message.loaded;
              broadcast();
            }
          }
        } catch { send(client, { type: 'error', error: 'Некоректне повідомлення.' }); }
      });
      client.on('close', broadcast);
      broadcast();
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of sockets.clients) {
      if (!client.alive) { client.terminate(); continue; }
      client.alive = false;
      client.ping();
      send(client, snapshot(client.voterId));
    }
  }, 10_000);
  heartbeat.unref();

  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    actualPort = server.address().port;
  } catch (error) {
    clearInterval(heartbeat);
    polls.close();
    await rm(storage, { recursive: true, force: true });
    throw error;
  }

  return {
    server, port: actualPort, hostToken, viewerToken, storage,
    hostUrl: `http://127.0.0.1:${actualPort}/host#token=${hostToken}`,
    async close() {
      if (closing) return;
      closing = true;
      clearInterval(heartbeat);
      annotations.close();
      polls.close();
      if (activeWorker) await activeWorker.terminate();
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      if (activeUpload) await activeUpload;
      await closed;
      await rm(storage, { recursive: true, force: true });
    },
  };
}
