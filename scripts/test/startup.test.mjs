import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertPortFree, waitForReady } from '../startup.mjs';

test('launcher rejects an occupied port with an actionable message', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await assert.rejects(assertPortFree(server.address().port), /занят/); }
  finally { await new Promise(resolve => server.close(resolve)); }
});

test('readiness waits for the matching service, not merely a spawned process', async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  let ready = false;
  const waiting = waitForReady(child, 'backend', 1000).then(() => { ready = true; });
  child.emit('message', { type: 'ready', service: 'frontend' });
  await Promise.resolve();
  assert.equal(ready, false);
  child.emit('message', { type: 'ready', service: 'backend' });
  await waiting;
  assert.equal(child.listenerCount('message'), 0);
});

test('readiness rejects an early exit and a startup timeout', async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  const waiting = waitForReady(child, 'backend', 1000);
  child.emit('exit', 1);
  await assert.rejects(waiting, /остановился до готовности/);
  await assert.rejects(waitForReady(child, 'backend', 10), /не запустился/);
});

test('missing Python fails preflight and standalone backend with a safe explanation', () => {
  const env = { ...process.env, PYTHON_BIN: 'qyzyljar-no-such-python-executable', OPENAI_API_KEY: 'do-not-print-this-test-value' };
  const cwd = fileURLToPath(new URL('../../backend/', import.meta.url));
  for (const script of ['scripts/check-env.js', 'src/server.js']) {
    const result = spawnSync(process.execPath, [script], { cwd, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ML_UNAVAILABLE/);
    assert.match(result.stderr, /PYTHON_BIN/);
    assert.doesNotMatch(result.stderr + result.stdout, /do-not-print-this-test-value|Qyzyljar AI backend:/);
  }
});
