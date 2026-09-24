import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createEngine } from "../src/engine.js";
import { createCityAgent } from "../src/agent.js";

const data = JSON.parse(
  readFileSync(new URL("../data/city.json", import.meta.url), "utf8"),
);
const engine = createEngine(data);
const validReport = {
  headline: "Город становится доступнее",
  summary: "Приоритет уделён слабому району.",
  strengths: ["Улучшаются социальные показатели Нуры."],
  tradeoffs: ["Бюджетный резерв ограничен."],
  risks: [
    {
      evidenceId: "low-reserve",
      explanation: "После выбранных вложений остаётся небольшой резерв.",
    },
  ],
  recommendations: [
    { strategyId: "quality", reason: "Этот вариант улучшает общий результат." },
  ],
  recommendedStrategyId: "quality",
  limitations: "Это учебная модель; поиск ограничен соседними вариантами.",
  nextQuestion: "Желаете ли вы чтобы мы помогли вам решить этот вопрос?",
};
function fakeClient(report = validReport, inspect = {}) {
  let round = 0;
  const requests = [];
  return {
    requests,
    responses: {
      async create(request) {
        requests.push(structuredClone(request));
        if (round++ < 2) {
          const name = round === 1 ? "compare_strategies" : "inspect_risks";
          return {
            status: "completed",
            output: [
              {
                type: "function_call",
                id: `fc_${round}`,
                call_id: `call_${round}`,
                name,
                arguments: "{}",
                status: "completed",
              },
            ],
          };
        }
        return {
          ...inspect,
          status: inspect.status ?? "completed",
          output: [],
          output_text: JSON.stringify(report),
        };
      },
    },
  };
}
test("agent executes real local tools before returning a report; metrics stay server-owned", async () => {
  const client = fakeClient();
  const result = await createCityAgent({ engine, client }).analyze({
    decisions: data.exampleDecisions,
  });
  assert.equal(result.simulation.score, 56.54307);
  assert.equal(result.analysis.status, "complete");
  assert.deepEqual(
    result.toolTrace.map((x) => x.tool),
    ["compare_strategies", "inspect_risks"],
  );
  assert.ok(
    client.requests[1].input.some((x) => x.type === "function_call_output"),
  );
  assert.equal(client.requests[0].store, false);
});
test("unknown risk evidence is rejected", async () => {
  const report = {
    ...validReport,
    risks: [{ evidenceId: "invented-risk", explanation: "Риск." }],
  };
  await assert.rejects(
    createCityAgent({ engine, client: fakeClient(report) }).analyze({
      decisions: data.exampleDecisions,
    }),
    (e) => e.code === "AI_UNKNOWN_EVIDENCE",
  );
});
test("AI report must end with the requested follow-up question", async () => {
  await assert.rejects(
    createCityAgent({
      engine,
      client: fakeClient({ ...validReport, nextQuestion: "Какой вариант выбрать?" }),
    }).analyze({ decisions: data.exampleDecisions }),
    (e) => e.code === "AI_INVALID_REPORT",
  );
});
test("numeric claims in model prose are rejected", async () => {
  await assert.rejects(
    createCityAgent({
      engine,
      client: fakeClient({ ...validReport, summary: "Score равен 99." }),
    }).analyze({ decisions: data.exampleDecisions }),
    (e) => e.code === "AI_INVALID_REPORT",
  );
});
test("incomplete model output cannot appear as successful analysis", async () => {
  await assert.rejects(
    createCityAgent({
      engine,
      client: fakeClient(validReport, { status: "incomplete" }),
    }).analyze({ decisions: data.exampleDecisions }),
    (e) => e.code === "AI_INCOMPLETE",
  );
});
test("invalid scenario never calls the model", async () => {
  const client = fakeClient();
  await assert.rejects(
    createCityAgent({ engine, client }).analyze({ decisions: [] }),
  );
  assert.equal(client.requests.length, 0);
});

test("usage sums every model request and applies cached-input pricing", async () => {
  const client = fakeClient();
  const original = client.responses.create;
  client.responses.create = async request => ({
    ...await original(request),
    usage: { input_tokens: 10000, output_tokens: 1000, input_tokens_details: { cached_tokens: 2000 } },
  });
  const result = await createCityAgent({ engine, client }).analyze({ decisions: data.exampleDecisions });
  assert.equal(result.usage.modelRequests, 3);
  assert.equal(result.usage.inputTokens, 30000);
  assert.equal(result.usage.outputTokens, 3000);
  assert.equal(result.usage.cachedInputTokens, 6000);
  assert.equal(result.usage.estimatedUsd, 0.01215);
});
