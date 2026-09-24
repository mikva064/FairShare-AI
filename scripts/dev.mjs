import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertPortFree, waitForReady } from './startup.mjs';

const frontend = fileURLToPath(new URL('../frontend/', import.meta.url));
const backend = fileURLToPath(new URL('../backend/', import.meta.url));
const children = new Set();
let closing = false;
function stop(code = 0) {
  closing = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

function launch(cwd, args, ipc = false) {
  if (closing) throw new Error('Запуск отменён.');
  const child = spawn(process.execPath, args, {
    cwd, windowsHide: true, stdio: ipc ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
    env: { ...process.env, PORT: '3010', HOST: '127.0.0.1' },
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}
async function runStep(cwd, args) {
  const child = launch(cwd, args);
  await new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Не удалось запустить проверку окружения или сборку.')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Запуск остановлен. Исправьте ошибку, указанную выше.')));
  });
}
async function startService(cwd, args, name) {
  const child = launch(cwd, args, true);
  child.once('exit', () => { if (!closing) stop(1); });
  child.once('error', () => { if (!closing) stop(1); });
  await waitForReady(child, name);
}

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 9)) throw new Error('Нужен Node.js 22.9 или новее.');
  if (!existsSync(new URL('../frontend/node_modules/typescript/bin/tsc', import.meta.url))
      || !existsSync(new URL('../backend/node_modules/express/package.json', import.meta.url))) {
    throw new Error('Сначала: npm.cmd --prefix backend ci и npm.cmd --prefix frontend ci');
  }
  await assertPortFree(3010);
  await assertPortFree(5180);
  await runStep(backend, ['--env-file-if-exists=.env', 'scripts/check-env.js']);
  await runStep(frontend, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.app.json']);
  await runStep(frontend, ['local-vite.mjs', 'build']);
  await startService(backend, ['--env-file-if-exists=.env', 'src/server.js'], 'backend');
  await startService(frontend, ['local-vite.mjs', 'preview'], 'frontend');
  console.log('Qyzyljar AI готов: http://127.0.0.1:5180\nCtrl+C останавливает оба сервера. Платных запросов при запуске нет.');
} catch (error) {
  if (!closing) console.error(error.message);
  stop(closing ? (process.exitCode ?? 1) : 1);
}
