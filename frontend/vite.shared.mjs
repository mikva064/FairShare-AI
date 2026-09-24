// Shared by the standard Vite config and the portable preview launcher.
export function apiProxy() {
  return {
    '/api': {
      target: 'http://127.0.0.1:3010',
      configure(proxy) {
        proxy.on('error', (_error, _req, res) => {
          if (!res || typeof res.writeHead !== 'function' || res.headersSent || res.destroyed) return;
          res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: {
            code: 'BACKEND_UNAVAILABLE',
            message: 'Backend на порту 3010 недоступен. Запустите npm.cmd run dev из корня проекта и проверьте ошибки Python в терминале.',
          } }));
        });
      },
    },
  };
}
export const localServer = { host: '127.0.0.1', port: 5180, strictPort: true };
