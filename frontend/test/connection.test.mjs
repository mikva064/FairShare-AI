import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { preview } from 'vite';
import { apiProxy } from '../vite.shared.mjs';

const source = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { request, requestStartup } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

test('repository has no generated config that shadows vite.config.ts', () => {
  assert.equal(existsSync(new URL('../vite.config.js', import.meta.url)), false);
  assert.equal(existsSync(new URL('../vite.config.d.ts', import.meta.url)), false);
  const standard = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
  const portable = readFileSync(new URL('../local-vite.mjs', import.meta.url), 'utf8');
  assert.ok(standard.includes('./vite.shared.mjs') && portable.includes('./vite.shared.mjs'));
  const config = JSON.parse(readFileSync(new URL('../tsconfig.node.json', import.meta.url), 'utf8'));
  assert.equal(config.compilerOptions.noEmit, true);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.dev, 'node ../scripts/dev.mjs');
});

test('client distinguishes HTML, upstream errors and malformed JSON', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>site</html>', { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(request('/api/health'), e => e.code === 'API_PROXY_MISSING' && !e.retryable);
  globalThis.fetch = async () => new Response('', { status: 500 });
  await assert.rejects(request('/api/health'), e => e.code === 'BACKEND_UNAVAILABLE' && e.retryable);
  globalThis.fetch = async () => new Response('{', { headers: { 'content-type': 'application/json' } });
  await assert.rejects(request('/api/health'), e => e.code === 'INVALID_API_JSON');
  globalThis.fetch = async () => new Response('null', { headers: { 'content-type': 'application/json' } });
  await assert.rejects(request('/api/health'), e => e.code === 'INVALID_API_RESPONSE');
});

test('startup GET retries a transient failure and accepts the next response', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return calls === 1
      ? new Response(JSON.stringify({ error: { code: 'BACKEND_UNAVAILABLE', message: 'Not ready' } }), { status: 503, headers: { 'content-type': 'application/json' } })
      : new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
  });
  assert.deepEqual(await requestStartup('/api/health', new AbortController().signal), { ok: true });
  assert.equal(calls, 2);
});

test('paid POST is never automatically retried', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new TypeError('offline'); });
  await assert.rejects(request('/api/analyze', { decisions: [] }), e => e.code === 'NETWORK_ERROR');
  assert.equal(calls, 1);
});

test('cancelling startup prevents further retries', async t => {
  let calls = 0;
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => { calls++; controller.abort(); throw new Error('aborted'); });
  await assert.rejects(requestStartup('/api/health', controller.signal));
  assert.equal(calls, 1);
});

test('actual Vite proxy returns structured 503 when backend is unavailable', async () => {
  const proxy = apiProxy();
  proxy['/api'].target = 'http://127.0.0.1:1';
  const server = await preview({
    configFile: false, root: fileURLToPath(new URL('../', import.meta.url)),
    logLevel: 'silent', preview: { host: '127.0.0.1', port: 0, open: false, proxy },
  });
  try {
    const response = await fetch('http://127.0.0.1:' + server.httpServer.address().port + '/api/health');
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'BACKEND_UNAVAILABLE');
  } finally {
    server.httpServer.closeAllConnections();
    await new Promise(resolve => server.httpServer.close(resolve));
  }
});
