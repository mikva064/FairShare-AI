import assert from "node:assert/strict";
const base = "http://127.0.0.1:5180";
const get = async path => {
  const response = await fetch(base + path);
  assert.equal(response.status, 200, path);
  return response.json();
};
const post = (path, body) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const health = await get("/api/health");
assert.equal(health.mlStatus, "connected");
const catalog = await get("/api/catalog");
const body = { decisions: catalog.exampleDecisions };
const response = await post("/api/simulate", body);
assert.equal(response.status, 200);
const result = await response.json();
assert.equal(result.score, 56.54307);
assert.equal(result.ml.status, "verified");
const strategies = await (await post("/api/strategies", body)).json();
assert.equal(strategies.strategies.length, 3);
assert.ok(strategies.strategies.every(s => s.simulation.ml.status === "verified"));
const invalid = await post("/api/simulate", { decisions: [] });
assert.equal(invalid.status, 422);
// Never invoke the paid route, even if someone configures a key later.
console.log(JSON.stringify({ ok: true, frontendProxy: true, pythonMl: result.ml.status, score: result.score, aiConfigured: health.aiConfigured, paidRequests: 0 }, null, 2));
