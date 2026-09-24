import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createEngine } from "../src/engine.js";
import { createApp } from "../src/app.js";
import { createIntegratedEngine, createMlRunner, verifyMlResult } from "../src/ml-engine.js";
const data = JSON.parse(readFileSync(new URL("../data/city.json", import.meta.url), "utf8"));
const base = createEngine(data);
const run = createMlRunner();
const engine = createIntegratedEngine(base, run);

test("real Python verifies synthetic example and strategy scores", () => {
  const result = engine.evaluate(data.exampleDecisions);
  assert.equal(result.ml.status, "verified");
  assert.equal(result.ml.score, 56.54);
  assert.equal(result.score, 56.54307);
  assert.ok(engine.strategies(data.exampleDecisions).every(s => s.simulation.ml.status === "verified"));
});

test("independent Python agrees across a deterministic corpus, including all measures", () => {
  let seed = 751;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const cases = [];
  const seen = new Set();
  for (let i = 0; i < 5000 && cases.length < 120; i++) {
    const pool = [...data.measures];
    const decisions = Array.from({ length: 5 }, () => {
      const m = pool.splice(Math.floor(random() * pool.length), 1)[0];
      return { measureId: m.id, ...(m.scope === "district" ? { districtId: data.districts[Math.floor(random() * data.districts.length)].id } : {}) };
    });
    if (base.validate(decisions).valid) {
      cases.push(decisions);
      decisions.forEach(d => seen.add(d.measureId));
    }
  }
  assert.equal(cases.length, 120);
  assert.equal(seen.size, data.measures.length);
  const results = run(cases);
  cases.forEach((decisions, i) => verifyMlResult(base.evaluate(decisions), results[i]));
});

test("Python rejects invalid sets and a numeric disagreement fails closed", () => {
  const invalid = run([[], [{ measureId: "unknown" }], data.exampleDecisions.map(() => ({ measureId: "M12" }))]);
  assert.ok(invalid.every(r => r.valid === false && r.score === null));
  const simulation = base.evaluate(data.exampleDecisions);
  const [ml] = run([data.exampleDecisions]);
  assert.throws(() => verifyMlResult(simulation, { ...ml, score: 99 }), e => e.code === "ML_RESULT_MISMATCH");
  assert.throws(() => verifyMlResult(simulation, { ...ml, indicators: {} }), e => e.code === "ML_RESULT_MISMATCH");
});

test("integrated HTTP endpoint calls real Python and preserves structured error responses", async () => {
  const server = createApp({ engine }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const health = await (await fetch(url + "/api/health")).json();
    assert.equal(health.mlStatus, "connected");
    const response = await fetch(url + "/api/simulate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decisions: data.exampleDecisions }) });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ml.status, "verified");
    assert.ok(body.risks.length > 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
