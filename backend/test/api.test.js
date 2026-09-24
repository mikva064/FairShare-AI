import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { createEngine } from "../src/engine.js";
import { createApp } from "../src/app.js";

const data = JSON.parse(
  readFileSync(new URL("../data/city.json", import.meta.url), "utf8"),
);
const engine = createEngine(data);
async function serve(t, options = {}) {
  const server = createApp({ engine, ...options }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    get: (path) => fetch(base + path),
    post: (path, body, headers = {}) =>
      fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
  };
}
test("API exposes reproducible catalog and evaluates a real scenario", async (t) => {
  const api = await serve(t);
  const catalog = await (await api.get("/api/catalog")).json();
  assert.equal(catalog.budget, 100);
  assert.equal(catalog.measures.length, 15);
  const response = await api.post("/api/simulate", {
    decisions: data.exampleDecisions,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).score, 56.54307);
});
test("invalid and forged inputs fail with machine-readable errors", async (t) => {
  const api = await serve(t);
  const invalid = await api.post("/api/simulate", { decisions: [] });
  assert.equal(invalid.status, 422);
  assert.equal((await invalid.json()).score, null);
  const forged = await api.post("/api/simulate", {
    decisions: data.exampleDecisions,
    budget: 1000,
  });
  assert.equal(forged.status, 400);
});
test("AI key absence is explicit; it is not replaced with fake model output", async (t) => {
  const api = await serve(t);
  const result = await api.post("/api/analyze", {
    decisions: data.exampleDecisions,
  });
  assert.equal(result.status, 503);
  const body = await result.json();
  assert.equal(body.error.code, "AI_NOT_CONFIGURED");
  assert.equal(body.simulation.score, 56.54307);
});
test("comparison returns ties and rejects invalid sets", async (t) => {
  const api = await serve(t);
  const response = await api.post("/api/compare", {
    scenarios: [
      { name: "A", decisions: data.exampleDecisions },
      { name: "B", decisions: [...data.exampleDecisions].reverse() },
    ],
  });
  assert.deepEqual((await response.json()).bestIndexes, [0, 1]);
  assert.equal(
    (
      await api.post("/api/compare", {
        scenarios: [
          { name: "A", decisions: [] },
          { name: "B", decisions: data.exampleDecisions },
        ],
      })
    ).status,
    422,
  );
});
test("allowed frontend receives CORS; other origins are rejected", async (t) => {
  const api = await serve(t, { origins: ["http://localhost:5180"] });
  const response = await api.post(
    "/api/simulate",
    { decisions: data.exampleDecisions },
    { origin: "http://localhost:5180" },
  );
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    "http://localhost:5180",
  );
  assert.equal(
    (
      await api.post(
        "/api/simulate",
        { decisions: data.exampleDecisions },
        { origin: "https://unrelated.example" },
      )
    ).status,
    403,
  );
});
test("paid AI route limits repeated requests and hides provider errors", async (t) => {
  const api = await serve(t, {
    aiRequestsPerMinute: 1,
    agent: {
      analyze: async () => {
        const e = new Error("secret-provider-body");
        e.status = 401;
        throw e;
      },
    },
  });
  const response = await api.post("/api/analyze", {
    decisions: data.exampleDecisions,
  });
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes("secret-provider-body"));
  assert.equal(
    (await api.post("/api/analyze", { decisions: data.exampleDecisions }))
      .status,
    429,
  );
});
