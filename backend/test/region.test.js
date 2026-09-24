import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEngine } from '../src/engine.js';
import { createIntegratedEngine, createMlRunner } from '../src/ml-engine.js';

const data = JSON.parse(readFileSync(new URL('../data/city.json', import.meta.url), 'utf8'));
const engine = createIntegratedEngine(createEngine(data), createMlRunner());

test('Petropavlovsk profile separates verified themes from synthetic numeric data', () => {
  assert.equal(data.profile.city, 'Петропавловск');
  assert.equal(data.synthetic, true);
  assert.equal(data.provenance.kind, 'synthetic');
  assert.match(data.profile.zoneNote, /не административное деление/);
  assert.equal(data.profile.sources.length, 3);
  assert.ok(data.profile.sources.every(s => new URL(s.url).hostname === 'www.gov.kz'));
  assert.equal(data.measures.length, 15);
  assert.ok(!data.measures.some(m => /ЛРТ/.test(m.name)));
  assert.deepEqual(data.districts.map(d => d.id), ['center', 'residential', 'industrial', 'riverside', 'developing']);
});

test('every regional preset is valid and independently verified by Python', () => {
  assert.equal(data.profile.presets.length, 4);
  for (const preset of data.profile.presets) {
    const result = engine.evaluate(preset.decisions);
    assert.equal(result.ml.status, 'verified', preset.name);
    assert.ok(result.budget.remaining >= 0);
    assert.equal(result.decisions.length, 5);
    const variants = engine.strategies(preset.decisions);
    assert.ok(variants.every(s => s.simulation.ml.status === 'verified'));
  }
});

test('new drainage initiative changes only its target zone and respects lag', () => {
  const scenario = data.profile.presets.find(p => p.id === 'resilience');
  const result = engine.evaluate(scenario.decisions);
  const zone = result.districts.find(d => d.id === 'riverside');
  const baseline = data.districts.find(d => d.id === 'riverside').indicators;
  assert.equal(zone.after.B1 - baseline.B1, 6);
  assert.equal(zone.after.C1 - baseline.C1, 13.5);
  assert.equal(result.ml.status, 'verified');
});
