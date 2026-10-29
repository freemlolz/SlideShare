import { createSlideSync } from './server.mjs';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT має бути цілим числом від 1 до 65535.');
  process.exit(1);
}
try {
  const application = await createSlideSync({ port, lanAddress: process.env.LAN_ADDRESS });
  console.log(`\nSlideSync Local\n\nВідкрийте на ноутбуці:\n${application.hostUrl}\n\nТелефони підключіть до тієї самої Wi-Fi-мережі та відскануйте QR на сторінці ведучого.\nCtrl+C — зупинити сервер і видалити тимчасові файли.\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await application.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (error) {
  console.error(error.code === 'EADDRINUSE' ? `Порт ${port} зайнятий. Запустіть із PORT=3001.` : error.message);
  process.exitCode = 1;
}
