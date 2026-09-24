import { readFileSync } from "node:fs";
import { createEngine } from "../src/engine.js";
const dataset = JSON.parse(
  readFileSync(new URL("../data/city.json", import.meta.url), "utf8"),
);
const engine = createEngine(dataset);
const result = engine.evaluate(dataset.exampleDecisions);
console.log(
  JSON.stringify(
    {
      budget: result.budget,
      baseline: result.baselineScore,
      score: result.score,
      delta: result.scoreDelta,
      criticalCount: result.formula.criticalCount,
      strategies: engine
        .strategies(dataset.exampleDecisions)
        .map((s) => ({
          id: s.id,
          score: s.simulation.score,
          remaining: s.simulation.budget.remaining,
          replacement: s.replacement,
          risks: s.risks.map((r) => r.message),
        })),
    },
    null,
    2,
  ),
);
