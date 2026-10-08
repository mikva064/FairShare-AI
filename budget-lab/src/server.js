import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaults, projects, modelInfo, exampleIds } from './catalog.js';
import { evaluate, optimize, InputError } from './engine.js';
import { budgetSource } from './budget-source.js';
import { createAdvisor, createOpenAiProvider, AiError } from './advisor.js';
import { loadConfig } from './config.js';

const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const publicRoot = new URL('../public/', import.meta.url);
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Cache-Control': 'no-store',
};
function json(res, status, data) {
  res.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new InputError('Отправьте JSON с Content-Type: application/json.');
  let size = 0;
  const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > 131_072) throw new InputError('Сценарий слишком большой: предел 128 КБ.');
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new InputError('Неверный JSON.'); }
}

export function createServer({ advisor = null, model = null } = {}) {
  let analysisRunning = false;
  const calls = [];
  return http.createServer(async (req, res) => {
    try {
      const port = req.socket.localPort;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(req.headers.host)) return json(res, 403, { error: 'Допускается только локальный адрес приложения.' });
      if (req.headers.origin && !hosts.map(host => `http://${host}`).includes(req.headers.origin)) return json(res, 403, { error: 'Запрос с другого сайта отклонён.' });
      const pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
      if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true, modelVersion: modelInfo.version, externalAi: Boolean(advisor), aiConfigured: Boolean(advisor), aiModel: advisor ? model : null, currency: 'KZT', budgetSourceId: budgetSource.id });
      if (req.method === 'GET' && pathname === '/api/catalog') return json(res, 200, { defaults, projects, modelInfo, exampleIds, budgetSource });
      if (req.method === 'GET' && pathname === '/api/budget-source') return json(res, 200, budgetSource);
      if (req.method === 'POST' && pathname === '/api/analyze') {
        const input = await readJson(req);
        if (input.allowPaid !== true) return json(res, 400, { code: 'PAID_CONFIRMATION_REQUIRED', error: 'Подтвердите один платный AI-анализ.' });
        if (!advisor) return json(res, 503, { code: 'AI_NOT_CONFIGURED', error: 'Добавьте OPENAI_API_KEY в локальный .env и перезапустите сервер.' });
        if (analysisRunning) return json(res, 429, { code: 'AI_BUSY', error: 'Другой анализ ещё выполняется. Дождитесь результата.' });
        const now = Date.now();
        while (calls.length && now - calls[0] >= 60_000) calls.shift();
        if (calls.length >= 3) return json(res, 429, { code: 'AI_LOCAL_RATE_LIMIT', error: 'Допустимо не больше трёх AI-анализов за минуту.' });
        analysisRunning = true; calls.push(now);
        try { return json(res, 200, await advisor(input)); }
        finally { analysisRunning = false; }
      }
      if (req.method === 'POST' && ['/api/evaluate', '/api/optimize'].includes(pathname)) {
        const input = await readJson(req);
        return json(res, 200, pathname === '/api/evaluate' ? evaluate(input) : optimize(input));
      }
      if (req.method === 'GET' && publicFiles.has(pathname)) {
        const [filename, mime] = publicFiles.get(pathname);
        const content = await readFile(new URL(filename, publicRoot));
        res.writeHead(200, { ...securityHeaders, 'Content-Type': mime });
        return res.end(content);
      }
      return json(res, 404, { error: 'Страница не найдена.' });
    } catch (error) {
      json(res, error instanceof InputError ? 400 : error instanceof AiError ? error.status : 500, { error: error instanceof InputError || error instanceof AiError ? error.message : 'Не удалось выполнить расчёт.', ...(error instanceof AiError ? { code: error.code } : {}) });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(process.argv[1]))) {
  const config = loadConfig();
  const { port } = config;
  const advisor = createAdvisor(createOpenAiProvider(config));
  const server = createServer({ advisor, model: config.model });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Порт ${port} занят. Остановите другую копию или задайте PORT.` : `Ошибка сервера: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`FairShare Budget Lab: http://127.0.0.1:${port}/`);
    console.log('Отдельная версия · тенге · собственный оптимизатор · бюджетный срез 09.07.2026');
    console.log(advisor ? `AI: ключ настроен · модель ${config.model}` : 'AI: ключ не настроен · расчёты доступны бесплатно');
    if (config.configurationWarning) console.log(config.configurationWarning);
    console.log('Эффекты проектов — допущения. Ctrl+C останавливает приложение.');
  });
}
