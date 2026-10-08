import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, projects, exampleIds } from '../src/catalog.js';
import { budgetSource, thousandsToKzt, validateBudgetSource } from '../src/budget-source.js';
import { createAdvisor, prepareContext, validateAnswer, createOpenAiProvider } from '../src/advisor.js';
import { createServer } from '../src/server.js';

const input = () => ({ config: structuredClone(defaults), projects: structuredClone(projects), selectedIds: [...exampleIds], question: 'Как сохранить резерв и улучшить эффект?' });
const answer = () => ({
  summary: 'Экономический вариант сохраняет существенный резерв и требует проверки исходных допущений.',
  findings: [{ text: 'Остаток после содержания обеспечивается текущим лимитом, без предполагаемой экономии.', evidenceIds: ['current.protectedReserve'] }],
  recommendation: { strategyId: 'economy', reason: 'Этот пакет предпочтителен для денежного результата. Социальные обязательства нужно обсудить отдельно.', evidenceIds: ['economy.npv', 'economy.protectedReserve'] },
  risks: [{ riskId: 'budget_scope', comment: 'Ассигнования города уже распределены; они не подтверждают свободный фонд для новых проектов.' }],
  missingData: ['Подтверждённые сметы и фактические расходы на содержание.'],
  sourceIds: [budgetSource.id],
});

test('source conversion preserves thousands of tenge exactly, including decimals and signs', () => {
  assert.equal(thousandsToKzt('104 170 716,3'), 104170716300);
  assert.equal(thousandsToKzt('1\u00a0338\u00a0831,0'), 1338831000);
  assert.equal(thousandsToKzt('-5 897 464,7'), -5897464700);
  assert.equal(thousandsToKzt('0,001'), 1);
  assert.throws(() => thousandsToKzt('0,0001'));
  assert.throws(() => thousandsToKzt('Infinity'));
});

test('budget groups reconcile and nested programs are not added again', () => {
  assert.equal(validateBudgetSource(), true);
  assert.equal(budgetSource.groups.reduce((sum, g) => sum + g.amountKzt, 0), 110418181000);
  assert.equal(budgetSource.totals.executiveReserveKzt, 1338831000);
  const bad = structuredClone(budgetSource); bad.groups[0].amountKzt++;
  assert.throws(() => validateBudgetSource(bad));
  assert.equal(budgetSource.year, 2026);
  assert.ok(budgetSource.coverageNote.includes('пока не импортированы'));
});

test('advisor executes local tools, keeps numbers server-owned and calls provider once', async () => {
  let calls = 0;
  const advisor = createAdvisor(async context => {
    calls++;
    assert.equal(context.report.budget.initialReserveKzt, 190000000);
    assert.equal(context.search.examined, 4096);
    assert.ok(context.facts.some(f => f.id === 'budget.expenditure' && f.value === 110418181000));
    return { answer: answer(), model: 'mock', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } };
  });
  const result = await advisor({ ...input(), facts: [{ id: 'current.protectedReserve', value: 999999999 }] });
  assert.equal(calls, 1);
  assert.equal(result.recommendationReport.budget.investedKzt, 110000000);
  assert.equal(result.facts.find(f => f.id === 'current.protectedReserve').value, 134900690);
  assert.equal(result.sourceFingerprint, budgetSource.fingerprint);
});

test('invalid portfolio and unknown budget reference never call a model', async () => {
  let calls = 0;
  const advisor = createAdvisor(async () => { calls++; return { answer: answer() }; });
  await assert.rejects(advisor({ ...input(), selectedIds: [] }), /исправьте сценарий/);
  await assert.rejects(advisor({ ...input(), referenceId: 'forged' }), /Неизвестная программа/);
  assert.equal(calls, 0);
});

test('fabricated amounts, evidence, risks, sources and strategies are rejected', () => {
  const context = prepareContext(input());
  for (const mutate of [
    a => { a.summary = 'Город сэкономит 9000000 тенге.'; },
    a => { a.summary = 'Город сэкономит миллиард тенге.'; },
    a => { a.findings[0].evidenceIds = ['forged.number']; },
    a => { a.recommendation.strategyId = 'made-up'; },
    a => { a.recommendation.evidenceIds = ['current.npv']; },
    a => { a.risks[0].riskId = 'unknown-flood'; },
    a => { a.sourceIds = ['fake-source']; },
    a => { a.findings = []; },
    a => { a.missingData = []; },
    a => { a.balance = 1000000; },
  ]) {
    const a = answer(); mutate(a);
    assert.throws(() => validateAnswer(a, context));
  }
});

test('comparison uses approved program as a reference, never as proof of available money', () => {
  const v = input(); v.referenceId = 'program-458-015'; v.config.budgetKzt = 2000000000;
  const context = prepareContext(v);
  assert.equal(context.reference.amountKzt, 1739553400);
  assert.ok(context.signals.some(s => s.id === 'reference_limit'));
  assert.ok(context.signals.some(s => s.id === 'budget_scope'));
});

test('Responses request is single, structured, not stored and correctly parses message after reasoning', async () => {
  let calls = 0;
  const provider = createOpenAiProvider({ apiKey: 'test-only-key', model: 'gpt-5-mini', fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(options.body);
    assert.equal(body.store, false); assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.type, 'json_schema'); assert.equal(body.max_output_tokens, 4000);
    assert.equal(body.instructions.includes('не свободный фонд'), true);
    return new Response(JSON.stringify({ status: 'completed', output: [
      { type: 'reasoning', summary: [] },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer()) }] },
    ], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } }), { status: 200 });
  } });
  const result = await createAdvisor(provider)(input());
  assert.equal(calls, 1); assert.equal(result.usage.totalTokens, 30);
});

test('provider errors are sanitized and never retried', async () => {
  const context = prepareContext(input());
  for (const [status, code, expected] of [[401, 'invalid_api_key', 'AI_KEY_REJECTED'], [429, 'insufficient_quota', 'AI_QUOTA'], [429, 'rate_limit', 'AI_RATE_LIMIT'], [404, 'model_not_found', 'AI_MODEL_UNAVAILABLE'], [500, 'internal', 'AI_PROVIDER_ERROR']]) {
    let calls = 0;
    const provider = createOpenAiProvider({ apiKey: 'test-only-key', model: 'gpt-5-mini', fetchImpl: async () => {
      calls++; return new Response(JSON.stringify({ error: { code, message: 'sensitive-provider-details' } }), { status });
    } });
    await assert.rejects(provider(context), error => error.code === expected && !error.message.includes('sensitive-provider-details'));
    assert.equal(calls, 1);
  }
});

test('incomplete generation and model refusal are not shown as successful analysis', async () => {
  const context = prepareContext(input());
  for (const [body, code] of [
    [{ status: 'incomplete', output: [] }, 'AI_INCOMPLETE'],
    [{ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }, 'AI_REFUSAL'],
  ]) {
    const provider = createOpenAiProvider({ apiKey: 'test-only-key', model: 'gpt-5-mini', fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }) });
    await assert.rejects(provider(context), error => error.code === code);
  }
});

test('paid route requires explicit flag, validates before model call and limits bursts', async () => {
  let calls = 0;
  const advisor = createAdvisor(async () => { calls++; return { answer: answer(), model: 'mock' }; });
  const server = createServer({ advisor, model: 'mock' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(`${url}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post(input())).status, 400);
    assert.equal(calls, 0);
    assert.equal((await post({ ...input(), allowPaid: true, selectedIds: [] })).status, 400);
    assert.equal(calls, 0);
    assert.equal((await post({ ...input(), allowPaid: true })).status, 200);
    assert.equal((await post({ ...input(), allowPaid: true })).status, 200);
    assert.equal((await post({ ...input(), allowPaid: true })).status, 429);
    assert.equal(calls, 2);
    const source = await (await fetch(`${url}/api/budget-source`)).json();
    assert.equal(source.totals.revenueKzt, 104170716300);
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.aiConfigured, true);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('absent key cannot produce a fake AI report', async () => {
  assert.equal(createOpenAiProvider({ apiKey: '', model: 'gpt-5-mini' }), null);
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input(), allowPaid: true }) });
    assert.equal(r.status, 503); assert.equal((await r.json()).code, 'AI_NOT_CONFIGURED');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
