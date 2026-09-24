import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createEngine, ScenarioError } from "../src/engine.js";

const data = JSON.parse(
  readFileSync(new URL("../data/city.json", import.meta.url), "utf8"),
);
const engine = createEngine(data);
const d = (measureId, districtId) => ({
  measureId,
  ...(districtId ? { districtId } : {}),
});
const example = () => structuredClone(data.exampleDecisions);
const cheap = [
  d("M9", "developing"),
  d("M11", "residential"),
  d("M10", "developing"),
  d("M12"),
  d("M4", "center"),
];

test("synthetic baseline and district table match the specified formula", () => {
  const b = engine.catalog().baseline;
  assert.equal(b.score, 52.55768);
  assert.equal(b.weightedAverage, 56.8624);
  assert.equal(b.criticalCount, 2);
  assert.deepEqual(
    b.districts.map((x) => x.score),
    [62.99, 57.06, 54.65, 56.63, 49.18],
  );
});
test("synthetic example: budget 95, no critical values, score 56.54307", () => {
  const r = engine.evaluate(example());
  assert.equal(r.budget.spent, 95);
  assert.equal(r.score, 56.54307);
  assert.equal(r.scoreDelta, 3.98539);
  assert.equal(r.formula.criticalCount, 0);
  const developing = r.districts.find((x) => x.id === "developing");
  assert.equal(developing.after.S1, 48);
  assert.equal(developing.after.S2, 43.75);
  assert.equal(developing.after.B1, 67.5); // Includes fixed +2 synergy, not scaled.
  assert.ok(r.districts.every((x) => x.deltas.C2 === 4.375));
});
test("five measures need not cover every direction; at most two per direction", () => {
  assert.equal(engine.evaluate(cheap).budget.spent, 61);
  const invalid = [
    d("M1", "center"),
    d("M2"),
    d("M3", "developing"),
    d("M12"),
    d("M9", "developing"),
  ];
  assert.ok(
    engine.validate(invalid).errors.some((e) => e.code === "DIRECTION_LIMIT"),
  );
});
test("exactly five, unknown IDs and repeats are rejected", () => {
  for (const decisions of [[], example().slice(1), [...example(), d("M2")]])
    assert.ok(
      engine
        .validate(decisions)
        .errors.some((e) => e.code === "DECISION_COUNT"),
    );
  const unknown = example();
  unknown[0] = d("made-up", "developing");
  assert.ok(
    engine.validate(unknown).errors.some((e) => e.code === "UNKNOWN_MEASURE"),
  );
  const repeated = example();
  repeated[0] = d("M8", "center");
  assert.ok(
    engine
      .validate(repeated)
      .errors.some((e) => e.code === "DUPLICATE_MEASURE"),
  );
});
test("budget is server-owned and invalid scenarios never get a score", () => {
  const expensive = [
    d("M3", "center"),
    d("M5", "industrial"),
    d("M7", "developing"),
    d("M10", "residential"),
    d("M13", "riverside"),
  ];
  assert.ok(
    engine.validate(expensive).errors.some((e) => e.code === "BUDGET_EXCEEDED"),
  );
  assert.throws(() => engine.evaluate(expensive), ScenarioError);
  const forged = example();
  forged[0].cost = 0;
  assert.equal(engine.validate(forged).valid, false);
});
test("district-scoped and city-scoped targets are enforced", () => {
  for (const target of [undefined, "unknown"]) {
    const items = example();
    items[0] = d("M7", target);
    assert.ok(
      engine.validate(items).errors.some((e) => e.code === "DISTRICT_REQUIRED"),
    );
  }
  const items = example();
  items[3] = d("M12", "developing");
  assert.ok(
    engine.validate(items).errors.some((e) => e.code === "CITY_HAS_DISTRICT"),
  );
});
test("global and same-district incompatibilities follow the dataset", () => {
  const bad = [
    d("M1", "center"),
    d("M3", "developing"),
    d("M9", "developing"),
    d("M11", "residential"),
    d("M12"),
  ];
  assert.ok(
    engine.validate(bad).errors.some((e) => e.code === "INCOMPATIBLE_MEASURES"),
  );
  for (const [a, b] of [
    ["M4", "M7"],
    ["M5", "M13"],
  ]) {
    const items = [
      d(a, "developing"),
      d(b, "developing"),
      d("M9", "residential"),
      d("M11", "center"),
      d("M12"),
    ];
    assert.ok(
      engine
        .validate(items)
        .errors.some((e) => e.code === "INCOMPATIBLE_MEASURES"),
    );
    items[1].districtId = "residential";
    assert.ok(
      !engine
        .validate(items)
        .errors.some((e) => e.code === "INCOMPATIBLE_MEASURES"),
    );
  }
});
test("critical threshold is strictly below 40 and negative effects are retained", () => {
  const r = engine.evaluate(cheap);
  const residential = r.districts.find((x) => x.id === "residential");
  assert.equal(residential.after.T1, 38.25);
  assert.ok(
    r.criticalIndicators.some(
      (x) => x.districtId === "residential" && x.indicatorId === "T1",
    ),
  );
  assert.ok(
    !engine.catalog().baseline.criticalIndicators.some((x) => x.value === 40),
  );
});
test("effects are clipped after summation, with order-independent results", () => {
  const high = structuredClone(data);
  for (const district of high.districts)
    for (const key of Object.keys(district.indicators))
      district.indicators[key] = 99;
  const e = createEngine(high);
  const decisions = [
    d("M2"),
    d("M11", "developing"),
    d("M9", "developing"),
    d("M12"),
    d("M4", "center"),
  ];
  const r = e.evaluate(decisions);
  assert.equal(r.districts.find((x) => x.id === "developing").after.T1, 100);
  assert.deepEqual(r, e.evaluate([...decisions].reverse()));
});
test("all fixed synergy pairs are applied without lag scaling", () => {
  const sets = [
    {
      decisions: [
        d("M1", "developing"),
        d("M2"),
        d("M9", "developing"),
        d("M11", "center"),
        d("M12"),
      ],
      district: "developing",
      indicator: "T1",
      expected: 64.5,
    },
    {
      decisions: [
        d("M5", "industrial"),
        d("M6"),
        d("M9", "developing"),
        d("M11", "center"),
        d("M12"),
      ],
      district: "industrial",
      indicator: "E2",
      expected: 52.25,
    },
  ];
  for (const item of sets)
    assert.equal(
      engine
        .evaluate(item.decisions)
        .districts.find((x) => x.id === item.district).after[item.indicator],
      item.expected,
    );
});
test("all strategies are valid, reproducible, and obey their stated objectives", () => {
  const before = engine.evaluate(example());
  const strategies = engine.strategies(example());
  assert.equal(strategies.length, 3);
  for (const s of strategies) {
    assert.equal(engine.validate(s.simulation.decisions).valid, true);
    assert.deepEqual(engine.evaluate(s.simulation.decisions), s.simulation);
  }
  assert.ok(strategies[0].simulation.score >= before.score);
  assert.ok(
    strategies[1].simulation.formula.minimumDistrictScore >=
      before.formula.minimumDistrictScore,
  );
  assert.ok(
    strategies[2].simulation.budget.remaining >= before.budget.remaining,
  );
  assert.ok(strategies[2].simulation.score >= before.score);
  assert.deepEqual(strategies, engine.strategies([...example()].reverse()));
});
test("catalog callers cannot mutate the engine and bad datasets fail fast", () => {
  const catalog = engine.catalog();
  catalog.budget = 999;
  catalog.districts[0].indicators.T1 = 100;
  assert.equal(engine.catalog().budget, 100);
  assert.equal(engine.catalog().districts[0].indicators.T1, 45);
  const invalid = structuredClone(data);
  invalid.indicators.T1.weight = 99;
  assert.throws(() => createEngine(invalid), /сумма весов/);
});
