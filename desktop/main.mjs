import { app, BrowserWindow, dialog, ipcMain, Menu, powerSaveBlocker, session, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSlideSync, localAddresses } from '../src/server.mjs';
import { createDesktopStore } from './store.mjs';
import { isJoinUrl, isPresenterUrl, startDesktopServer } from './runtime.mjs';

app.setName('SlideSync Local');
if (app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', app.commandLine.getSwitchValue('user-data-dir'));
let window;
let application;
let blocker;
let quitting = false;
let stopped = false;

async function requestQuit() {
  if (quitting) return;
  quitting = true;
  if (window && !window.isDestroyed()) {
    const { response } = await dialog.showMessageBox(window, {
      type: 'question', title: 'Завершити показ?',
      message: 'Закрити SlideSync Local?',
      detail: 'Телефони втратять зв’язок. PDF і голоси буде видалено. Збережені питання залишаться.',
      buttons: ['Завершити показ', 'Продовжити'], defaultId: 1, cancelId: 1,
    });
    if (response !== 0) { quitting = false; return; }
  }
  try {
    if (blocker !== undefined) powerSaveBlocker.stop(blocker);
    await application?.close();
    stopped = true;
    app.quit();
  } catch {
    quitting = false;
    dialog.showErrorBox('Не вдалося завершити показ', 'Повторіть закриття застосунку.');
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });
  app.on('activate', () => { window?.show(); window?.focus(); });
  app.on('before-quit', (event) => {
    if (stopped) return;
    event.preventDefault();
    void requestQuit();
  });
  app.whenReady().then(async () => {
    const store = createDesktopStore(app.getPath('userData'));
    application = await startDesktopServer(createSlideSync, store.port);
    store.setPort(application.port);
    const origin = new URL(application.hostUrl).origin;
    const addresses = ['127.0.0.1', ...localAddresses()];
    window = new BrowserWindow({
      width: 1280, height: 860, minWidth: 780, minHeight: 600,
      title: 'SlideSync Local — macOS Beta', backgroundColor: '#f3f6fa', show: false,
      webPreferences: {
        preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
        nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
        session: session.fromPartition('slidesync-presenter', { cache: false }),
      },
    });
    const authorized = (event) => event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame && isPresenterUrl(event.senderFrame.url, origin);
    ipcMain.on('slidesync:read-polls', (event) => {
      event.returnValue = authorized(event) ? { value: store.readPolls() } : { error: 'Недозволене джерело.' };
    });
    ipcMain.handle('slidesync:write-polls', (event, serialized) => {
      if (!authorized(event)) throw new Error('Недозволене джерело.');
      store.writePolls(serialized);
    });
    const permissions = new Set(['clipboard-sanitized-write', 'fullscreen']);
    window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(contents === window.webContents && details.isMainFrame
        && isPresenterUrl(details.requestingUrl, origin) && permissions.has(permission));
    });
    window.webContents.session.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
      contents === window.webContents && requestingOrigin === origin && permissions.has(permission));
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isJoinUrl(url, { port: application.port, viewerToken: application.viewerToken, addresses })) {
        void shell.openExternal(url).catch(() => dialog.showErrorBox('Не вдалося відкрити браузер', 'Скопіюйте посилання з QR-панелі.'));
      }
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => { if (!isPresenterUrl(url, origin)) event.preventDefault(); });
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.on('close', (event) => { if (!stopped) { event.preventDefault(); void requestQuit(); } });
    window.once('ready-to-show', () => window.show());
    blocker = powerSaveBlocker.start('prevent-display-sleep');
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'SlideSync Local', submenu: [
        { label: 'Про SlideSync Local', click: () => dialog.showMessageBox(window, {
          type: 'info', message: `SlideSync Local ${app.getVersion()} · macOS Beta`,
          detail: 'Без хмари та встановлення на телефонах. Mac і телефони мають бути в одній Wi-Fi-мережі. Застосунок не дає Mac заснути; не закривайте кришку.',
        }) },
        { type: 'separator' }, { role: 'hide', label: 'Приховати SlideSync Local' },
        { type: 'separator' }, { label: 'Завершити показ', accelerator: 'CmdOrCtrl+Q', click: () => void requestQuit() },
      ] },
      { label: 'Редагування', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'Вікно', submenu: [{ role: 'minimize' }, { role: 'togglefullscreen' }] },
    ]));
    await window.loadURL(application.hostUrl);
  }).catch(async () => {
    await application?.close().catch(() => {});
    if (blocker !== undefined) powerSaveBlocker.stop(blocker);
    dialog.showErrorBox('SlideSync Local не запустився',
      `Перевірте доступ до локальної мережі та вільне місце. Збережені питання: ${path.join(app.getPath('userData'), 'desktop-state.json')}. Якщо файл пошкоджений, збережіть його копію перед відновленням.`);
    stopped = true;
    app.exit(1);
  });
}
