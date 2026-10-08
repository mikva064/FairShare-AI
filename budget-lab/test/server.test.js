import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { defaults, projects, exampleIds } from '../src/catalog.js';

test('web UI and API work together locally; rejected inputs and foreign origins are explicit', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.currency, 'KZT'); assert.equal(health.externalAi, false);
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Budget Lab/);
    assert.ok(page.headers.get('content-security-policy').includes("script-src 'self'"));
    const payload = { config: defaults, projects, selectedIds: exampleIds };
    const post = (path, body = payload, headers = {}) => fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const evaluated = await (await post('/api/evaluate')).json();
    assert.equal(evaluated.valid, true);
    assert.equal(evaluated.budget.initialReserveKzt, 190000000);
    const searched = await (await post('/api/optimize')).json();
    assert.equal(searched.complete, true); assert.equal(searched.strategies.length, 3);
    const bad = await post('/api/evaluate', { ...payload, selectedIds: ['fake'] });
    assert.equal(bad.status, 400); assert.ok((await bad.json()).error);
    const foreign = await post('/api/evaluate', payload, { Origin: 'https://other.example' });
    assert.equal(foreign.status, 403);
    const secret = await fetch(`${url}/.env`); assert.equal(secret.status, 404);
    const malformed = await fetch(`${url}/api/evaluate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
