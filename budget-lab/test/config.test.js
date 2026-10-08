import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

function fixture(t, text = '') {
  const dir = mkdtempSync(join(tmpdir(), 'fairshare-config-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, '.env');
  writeFileSync(path, text);
  return { dir, path };
}

test('local configuration loads a referenced key without inheriting its model or port', t => {
  const { dir, path } = fixture(t, 'OPENAI_ENV_FILE=old.env\nOPENAI_MODEL=gpt-5-mini\nPORT=5181\n');
  writeFileSync(join(dir, 'old.env'), 'OPENAI_API_KEY=test-only-key\nOPENAI_MODEL=other-model\nPORT=9999\n');
  const config = loadConfig({}, path);
  assert.equal(config.apiKey, 'test-only-key');
  assert.equal(config.model, 'gpt-5-mini');
  assert.equal(config.port, 5181);
  assert.equal(config.configurationWarning, null);
});

test('environment overrides the local file, and an explicit blank key disables the fallback', t => {
  const { dir, path } = fixture(t, 'OPENAI_API_KEY=local-test-key\nOPENAI_ENV_FILE=old.env\n');
  writeFileSync(join(dir, 'old.env'), 'OPENAI_API_KEY=fallback-test-key\n');
  assert.equal(loadConfig({ OPENAI_API_KEY: 'environment-test-key', PORT: '5182' }, path).apiKey, 'environment-test-key');
  assert.equal(loadConfig({ PORT: '5182' }, path).port, 5182);
  assert.equal(loadConfig({ OPENAI_API_KEY: '' }, path).apiKey, '');
});

test('missing optional key files keep free tools available and unsafe settings are rejected', t => {
  const { path } = fixture(t, 'OPENAI_ENV_FILE=missing.env\n');
  const config = loadConfig({}, path);
  assert.equal(config.apiKey, '');
  assert.ok(config.configurationWarning);
  assert.throws(() => loadConfig({ PORT: '70000' }, path), /PORT/);
  assert.throws(() => loadConfig({ OPENAI_MODEL: 'invalid/model' }, path), /OPENAI_MODEL/);
});
