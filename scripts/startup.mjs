import { createServer } from 'node:net';

export async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error('Порт ' + port + ' занят или недоступен. Остановите предыдущий запуск проекта.')));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
export function waitForReady(child, service, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', message); child.off('exit', exited); child.off('error', failed);
    };
    const done = error => { cleanup(); error ? reject(error) : resolve(); };
    const message = data => { if (data?.type === 'ready' && data.service === service) done(); };
    const exited = () => done(new Error(service + ' остановился до готовности. Смотрите сообщение выше.'));
    const failed = () => done(new Error('Не удалось запустить ' + service + '.'));
    const timer = setTimeout(() => done(new Error(service + ' не запустился за отведённое время.')), timeoutMs);
    child.on('message', message); child.once('exit', exited); child.once('error', failed);
    if (child.exitCode !== null || child.signalCode !== null) exited();
  });
}
