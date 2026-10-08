import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, projects, exampleIds } from '../src/catalog.js';
import { evaluate, normalize, optimize, InputError } from '../src/engine.js';

const input = () => ({ config: structuredClone(defaults), projects: structuredClone(projects), selectedIds: [...exampleIds] });
function single(overrides = {}, config = {}) {
  return {
    config: { ...structuredClone(defaults), budgetKzt: 1000, reserveKzt: 100, futureFloorKzt: 100, horizonYears: 3, discountPct: 0, costInflationPct: 0, ...config },
    projects: [{ ...structuredClone(projects[0]), id: 'only', costKzt: 100, annualOperatingKzt: 10, annualSavingKzt: 50, annualRiskProbability: 0, damageKzt: 0, mitigationPct: 0, startYear: 1, impactPoints: 10, ...overrides }],
    selectedIds: ['only'],
  };
}

test('tenge balances reconcile exactly and future reserve funds operating costs', () => {
  const r = evaluate(single());
  assert.equal(r.valid, true);
  assert.equal(r.budget.investedKzt, 100);
  assert.equal(r.budget.initialReserveKzt, 900);
  assert.equal(r.budget.operatingProvisionKzt, 30);
  assert.equal(r.budget.protectedFutureKzt, 870);
  assert.equal(r.budget.expectedFutureCashKzt, 1020);
  assert.equal(r.uncertainty.base.netEffectKzt, 20);
  assert.equal(r.uncertainty.base.npvKzt, 20);
  assert.equal(r.uncertainty.base.cashPaybackYear, 3);
});

test('avoided loss affects economic benefit, never cash or protected reserve', () => {
  const r = evaluate(single({ annualSavingKzt: 0, annualRiskProbability: 0.2, damageKzt: 1000, mitigationPct: 50 }));
  assert.equal(r.uncertainty.base.avoidedLossKzt, 300);
  assert.equal(r.uncertainty.base.grossBenefitKzt, 300);
  assert.equal(r.uncertainty.base.npvKzt, 170);
  assert.equal(r.budget.expectedFutureCashKzt, 870);
  assert.equal(r.budget.protectedFutureKzt, 870);
  assert.equal(r.uncertainty.base.cashPaybackYear, null);
});

test('future reserve cannot rely on optimistic savings or prevented damage', () => {
  const r = evaluate(single({ costKzt: 400, annualOperatingKzt: 180, annualSavingKzt: 1000, annualRiskProbability: 1, damageKzt: 10000, mitigationPct: 100 }));
  assert.equal(r.budget.initialReserveKzt, 600);
  assert.equal(r.budget.protectedFutureKzt, 60);
  assert.equal(r.valid, false);
  assert.match(r.errors.join(' '), /содержания/);
});

test('inflation, delayed start and discounting use the specified years', () => {
  const r = evaluate(single({ startYear: 2 }, { costInflationPct: 10, discountPct: 10 }));
  const rows = r.uncertainty.base.years;
  assert.equal(rows[0].operatingKzt, 0);
  assert.equal(rows[0].savingsKzt, 0);
  assert.equal(rows[1].operatingKzt, 11);
  assert.equal(rows[2].operatingKzt, 12);
  assert.equal(r.uncertainty.base.npvKzt, Math.round(-100 + 39 / 1.1 ** 2 + 37.9 / 1.1 ** 3));
  assert.equal(r.impactPoints, 6.666667);
});

test('low/high scenarios change benefit only, not guaranteed money', () => {
  const r = evaluate(single());
  assert.equal(r.uncertainty.low.savingsKzt, 98);
  assert.equal(r.uncertainty.high.savingsKzt, 203);
  assert.equal(r.uncertainty.low.protectedFutureKzt, r.uncertainty.high.protectedFutureKzt);
  assert.equal(r.uncertainty.low.operatingKzt, r.uncertainty.high.operatingKzt);
});

test('invalid selections retain visible balances but never become admissible', () => {
  const v = single({ costKzt: 950 });
  const r = evaluate(v);
  assert.equal(r.valid, false);
  assert.equal(r.budget.initialReserveKzt, 50);
  assert.match(r.errors.join(' '), /обязательного резерва/);
  v.selectedIds = [];
  assert.equal(evaluate(v).valid, false);
});

test('locked projects are mandatory, negative effects and unprofitable social projects remain visible', () => {
  const v = input(); v.config.lockedIds = ['P12'];
  assert.equal(evaluate(v).valid, false);
  const result = optimize(v);
  assert.equal(result.complete, true);
  assert.equal(result.strategies.length, 3);
  for (const s of result.strategies) {
    assert.equal(s.report.valid, true);
    assert.ok(s.report.selectedIds.includes('P12'));
  }
  assert.ok(evaluate(single({ annualSavingKzt: 0 })).uncertainty.base.netEffectKzt < 0);
});

test('optimizer finds the best goals among all admissible subsets', () => {
  const v = { ...single(), projects: [
    { ...single().projects[0], id: 'a', costKzt: 100, annualSavingKzt: 60, impactPoints: 10 },
    { ...single().projects[0], id: 'b', costKzt: 200, annualSavingKzt: 0, impactPoints: 50 },
    { ...single().projects[0], id: 'c', costKzt: 50, annualSavingKzt: 0, annualOperatingKzt: 0, impactPoints: 5 },
  ], selectedIds: ['a'] };
  v.config.maxProjects = 2;
  const result = optimize(v);
  assert.equal(result.examined, 8);
  assert.equal(result.feasible, 6);
  assert.deepEqual(result.strategies.find(s => s.id === 'social').report.selectedIds, ['a', 'b']);
  assert.deepEqual(result.strategies.find(s => s.id === 'economy').report.selectedIds, ['a']);
  assert.deepEqual(result.strategies.find(s => s.id === 'reserve').report.selectedIds, ['c']);
});

test('no feasible package is reported honestly', () => {
  const v = single(); v.config.reserveKzt = 1000;
  const result = optimize(v);
  assert.equal(result.complete, true);
  assert.equal(result.feasible, 0);
  assert.deepEqual(result.strategies, []);
});

test('money, IDs and probability inputs are validated without coercion', () => {
  for (const mutate of [
    v => { v.config.budgetKzt = '500000000'; },
    v => { v.config.budgetKzt = Infinity; },
    v => { v.projects[0].costKzt = 12.5; },
    v => { v.projects[0].annualRiskProbability = 1.01; },
    v => { v.projects[0].annualSavingKzt = -1; },
    v => { v.selectedIds = ['unknown']; },
    v => { v.selectedIds.push(v.selectedIds[0]); },
    v => { v.projects[1].id = v.projects[0].id; },
    v => { v.config.lockedIds = ['unknown']; },
    v => { v.config.reserveKzt = v.config.budgetKzt + 1; },
    v => { v.projects[0].source = ''; },
  ]) {
    const v = input(); mutate(v);
    assert.throws(() => normalize(v), InputError);
  }
});

test('full search is bounded by catalog size and does not mutate inputs', () => {
  const v = input(); const before = JSON.stringify(v);
  const r = optimize(v);
  assert.equal(r.examined, 4096);
  assert.equal(r.feasible, 1580);
  assert.equal(JSON.stringify(v), before);
  const oversized = input();
  for (let i = 0; i < 4; i++) oversized.projects.push({ ...oversized.projects[0], id: `extra${i}` });
  assert.throws(() => optimize(oversized), /15/);
});

test('fingerprint changes with monetary assumptions and is independent of selection order', () => {
  const v = input(); const first = evaluate(v).fingerprint;
  v.selectedIds.reverse(); assert.equal(evaluate(v).fingerprint, first);
  v.projects[0].annualSavingKzt++; assert.notEqual(evaluate(v).fingerprint, first);
});

test('effect after horizon is excluded, without pretending money is recovered', () => {
  const r = evaluate(single({ startYear: 5 }, { horizonYears: 3 }));
  assert.equal(r.uncertainty.base.savingsKzt, 0);
  assert.equal(r.uncertainty.base.operatingKzt, 0);
  assert.equal(r.uncertainty.base.npvKzt, -100);
  assert.equal(r.impactPoints, 0);
  assert.ok(r.warnings.some(w => w.includes('после выбранного горизонта')));
});
