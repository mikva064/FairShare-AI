import { createHash } from "node:crypto";

const rounded = (value) => Math.round((value + Number.EPSILON) * 1e6) / 1e6;
const clean = (value) =>
  JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "number" ? rounded(v) : v)),
  );
const invariant = (condition, message) => {
  if (!condition) throw new Error(`Некорректный датасет: ${message}`);
};

export class ScenarioError extends Error {
  constructor(validation) {
    super("Набор решений нарушает правила симулятора.");
    this.validation = validation;
  }
}

export function createEngine(source) {
  const data = structuredClone(source);
  const keys = Object.keys(data.indicators);
  const districtMap = new Map(data.districts.map((d) => [d.id, d]));
  const measureMap = new Map(data.measures.map((m) => [m.id, m]));
  const finite = (n) => typeof n === "number" && Number.isFinite(n);
  invariant(finite(data.budget) && data.budget >= 0, "бюджет");
  invariant(
    Number.isInteger(data.horizonQuarters) && data.horizonQuarters > 0,
    "горизонт",
  );
  invariant(
    data.decisionsRequired === 5 && data.maxPerDirection === 2,
    "правила пяти решений",
  );
  invariant(
    keys.length === 10 && data.districts.length > 0,
    "показатели и учебные зоны",
  );
  invariant(
    districtMap.size === data.districts.length &&
      measureMap.size === data.measures.length,
    "повтор ID",
  );
  invariant(
    Math.abs(keys.reduce((s, k) => s + data.indicators[k].weight, 0) - 1) <
      1e-9,
    "сумма весов",
  );
  invariant(
    Math.abs(data.districts.reduce((s, d) => s + d.populationShare, 0) - 1) <
      1e-9,
    "доли населения",
  );
  for (const k of keys)
    invariant(
      finite(data.indicators[k].weight) &&
        data.indicators[k].weight >= 0 &&
        data.indicators[k].direction in data.directions,
      `вес ${k}`,
    );
  for (const district of data.districts) {
    invariant(
      finite(district.populationShare) && district.populationShare > 0,
      "доля населения зоны",
    );
    for (const k of keys)
      invariant(
        finite(district.indicators[k]) &&
          district.indicators[k] >= 0 &&
          district.indicators[k] <= 100,
        `значение ${district.id}/${k}`,
      );
  }
  for (const measure of data.measures) {
    invariant(
      measure.direction in data.directions &&
        ["district", "city"].includes(measure.scope),
      `тип меры ${measure.id}`,
    );
    invariant(
      finite(measure.cost) && measure.cost >= 0,
      `стоимость ${measure.id}`,
    );
    invariant(
      Number.isInteger(measure.lagQuarters) &&
        measure.lagQuarters >= 0 &&
        measure.lagQuarters <= data.horizonQuarters,
      `лаг ${measure.id}`,
    );
    for (const [k, v] of Object.entries(measure.effects))
      invariant(keys.includes(k) && finite(v), `эффект ${measure.id}/${k}`);
  }
  invariant(
    finite(data.criticalThreshold) &&
      finite(data.criticalPenalty) &&
      data.criticalPenalty >= 0,
    "критические значения",
  );
  invariant(
    finite(data.averageWeight) &&
      finite(data.minimumWeight) &&
      data.averageWeight >= 0 &&
      data.minimumWeight >= 0 &&
      Math.abs(data.averageWeight + data.minimumWeight - 1) < 1e-9,
    "формула Score",
  );
  for (const rule of [...data.synergies, ...data.incompatibilities]) {
    invariant(
      rule.measureIds.length === 2 &&
        rule.measureIds.every((id) => measureMap.has(id)),
      "пары мер",
    );
  }
  for (const synergy of data.synergies) {
    invariant(
      synergy.measureIds.includes(synergy.targetMeasureId) &&
        measureMap.get(synergy.targetMeasureId).scope === "district",
      "район синергии",
    );
    for (const [k, v] of Object.entries(synergy.effects))
      invariant(keys.includes(k) && finite(v), "эффекты синергии");
  }
  for (const conflict of data.incompatibilities)
    invariant(
      ["any", "same-district"].includes(conflict.scope),
      "тип несовместимости",
    );
  const datasetVersion = `${data.id}-${createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 12)}`;
  const canonical = (decisions) =>
    decisions
      .map((d) => ({
        measureId: d.measureId,
        ...(d.districtId ? { districtId: d.districtId } : {}),
      }))
      .sort((a, b) => a.measureId.localeCompare(b.measureId));

  function validate(decisions) {
    const errors = [];
    let spent = 0;
    const seen = new Set();
    const directions = {};
    const push = (code, message) => errors.push({ code, message });
    if (!Array.isArray(decisions))
      return {
        valid: false,
        errors: [
          {
            code: "INVALID_DECISIONS",
            message: "decisions должен быть массивом.",
          },
        ],
        budget: { total: data.budget, spent: 0, remaining: data.budget },
        decisionCount: 0,
      };
    if (decisions.length !== data.decisionsRequired)
      push("DECISION_COUNT", "Нужно выбрать ровно 5 мероприятий.");
    for (const decision of decisions) {
      if (
        !decision ||
        typeof decision !== "object" ||
        Array.isArray(decision) ||
        Object.keys(decision).some(
          (k) => !["measureId", "districtId"].includes(k),
        )
      ) {
        push(
          "INVALID_DECISION",
          "Решение должно содержать только measureId и districtId.",
        );
        continue;
      }
      const m = measureMap.get(decision.measureId);
      if (!m) {
        push(
          "UNKNOWN_MEASURE",
          `Неизвестная мера: ${String(decision.measureId)}.`,
        );
        continue;
      }
      spent += m.cost;
      if (seen.has(m.id))
        push("DUPLICATE_MEASURE", `Мера ${m.id} выбрана несколько раз.`);
      seen.add(m.id);
      directions[m.direction] = (directions[m.direction] ?? 0) + 1;
      if (m.scope === "district" && !districtMap.has(decision.districtId))
        push("DISTRICT_REQUIRED", `Для ${m.id} укажите существующий район.`);
      if (m.scope === "city" && decision.districtId != null)
        push(
          "CITY_HAS_DISTRICT",
          `Для городской меры ${m.id} район не указывается.`,
        );
    }
    for (const [direction, count] of Object.entries(directions))
      if (count > data.maxPerDirection)
        push(
          "DIRECTION_LIMIT",
          `В направлении «${data.directions[direction]}» выбрано больше 2 мер.`,
        );
    if (spent > data.budget)
      push(
        "BUDGET_EXCEEDED",
        `Стоимость ${spent} превышает бюджет ${data.budget}.`,
      );
    for (const rule of data.incompatibilities) {
      const [a, b] = rule.measureIds.map((id) =>
        decisions.find((d) => d?.measureId === id),
      );
      if (
        a &&
        b &&
        (rule.scope === "any" ||
          (a.districtId && a.districtId === b.districtId))
      )
        push(
          "INCOMPATIBLE_MEASURES",
          `${rule.measureIds.join(" + ")}: ${rule.reason}`,
        );
    }
    return {
      valid: errors.length === 0,
      errors,
      budget: { total: data.budget, spent, remaining: data.budget - spent },
      decisionCount: decisions.length,
      directions,
    };
  }

  // Internal calculation also supports subsets for the baseline and attribution;
  // the public evaluator always validates all five decisions first.
  function calculate(decisions) {
    const districts = structuredClone(data.districts);
    const effects = [];
    for (const decision of canonical(decisions)) {
      const m = measureMap.get(decision.measureId);
      const factor =
        (data.horizonQuarters - m.lagQuarters) / data.horizonQuarters;
      const targets = districts.filter(
        (d) => m.scope === "city" || d.id === decision.districtId,
      );
      const realizedEffects = Object.fromEntries(
        Object.entries(m.effects).map(([k, v]) => [k, v * factor]),
      );
      for (const d of targets)
        for (const [k, v] of Object.entries(realizedEffects))
          d.indicators[k] += v;
      effects.push({
        measureId: m.id,
        name: m.name,
        direction: m.direction,
        cost: m.cost,
        lagQuarters: m.lagQuarters,
        realizedFraction: factor,
        districtIds: targets.map((d) => d.id),
        realizedEffects,
      });
    }
    const synergies = [];
    for (const rule of data.synergies) {
      if (
        !rule.measureIds.every((id) =>
          decisions.some((d) => d.measureId === id),
        )
      )
        continue;
      const districtId = decisions.find(
        (d) => d.measureId === rule.targetMeasureId,
      ).districtId;
      const target = districts.find((d) => d.id === districtId);
      for (const [k, v] of Object.entries(rule.effects))
        target.indicators[k] += v;
      synergies.push({
        measureIds: rule.measureIds,
        districtId,
        effects: rule.effects,
      });
    }
    let weightedAverage = 0;
    const criticalIndicators = [];
    for (const d of districts) {
      for (const k of keys) {
        d.indicators[k] = Math.min(100, Math.max(0, d.indicators[k]));
        if (d.indicators[k] < data.criticalThreshold)
          criticalIndicators.push({
            districtId: d.id,
            indicatorId: k,
            value: d.indicators[k],
          });
      }
      d.score = keys.reduce(
        (sum, k) => sum + data.indicators[k].weight * d.indicators[k],
        0,
      );
      weightedAverage += d.populationShare * d.score;
    }
    const minimumDistrictScore = Math.min(...districts.map((d) => d.score));
    const criticalPenalty = data.criticalPenalty * criticalIndicators.length;
    const score =
      data.averageWeight * weightedAverage +
      data.minimumWeight * minimumDistrictScore -
      criticalPenalty;
    return {
      score,
      weightedAverage,
      minimumDistrictScore,
      criticalPenalty,
      criticalCount: criticalIndicators.length,
      criticalIndicators,
      districts,
      effects,
      synergies,
    };
  }

  const base = calculate([]);

  function evaluate(decisions) {
    const validation = validate(decisions);
    if (!validation.valid) throw new ScenarioError(validation);
    const normalized = canonical(decisions);
    const result = calculate(normalized);
    return clean({
      datasetVersion,
      valid: true,
      decisions: normalized,
      budget: validation.budget,
      baselineScore: base.score,
      score: result.score,
      scoreDelta: result.score - base.score,
      formula: {
        weightedAverage: result.weightedAverage,
        minimumDistrictScore: result.minimumDistrictScore,
        criticalCount: result.criticalCount,
        criticalPenalty: result.criticalPenalty,
        averageWeight: data.averageWeight,
        minimumWeight: data.minimumWeight,
      },
      districts: result.districts.map((d) => {
        const before = base.districts.find((x) => x.id === d.id);
        return {
          id: d.id,
          name: d.name,
          populationShare: d.populationShare,
          before: before.indicators,
          after: d.indicators,
          deltas: Object.fromEntries(
            keys.map((k) => [k, d.indicators[k] - before.indicators[k]]),
          ),
          baselineScore: before.score,
          score: d.score,
          scoreDelta: d.score - before.score,
        };
      }),
      criticalIndicators: result.criticalIndicators,
      synergies: result.synergies,
      measures: result.effects.map((m) => ({
        ...m,
        marginalScore:
          result.score -
          calculate(normalized.filter((d) => d.measureId !== m.measureId))
            .score,
      })),
      attributionNote:
        "marginalScore — разница при исключении одной меры из полного набора, включая потерю синергий. Эти вклады не складываются в scoreDelta из-за минимума и пороговых штрафов.",
    });
  }

  // Bounded one-decision neighbourhood, not a claim of global optimality.
  function neighbourhood(decisions) {
    const validation = validate(decisions);
    if (!validation.valid) throw new ScenarioError(validation);
    const currentScore = calculate(decisions).score;
    const candidates = [];
    const seen = new Set();
    for (let index = 0; index < decisions.length; index++) {
      for (const m of data.measures) {
        const targets =
          m.scope === "city" ? [null] : data.districts.map((d) => d.id);
        for (const districtId of targets) {
          const candidate = decisions.map((d, i) =>
            i === index
              ? { measureId: m.id, ...(districtId ? { districtId } : {}) }
              : d,
          );
          const key = JSON.stringify(canonical(candidate));
          if (seen.has(key)) continue;
          seen.add(key);
          if (!validate(candidate).valid) continue;
          const score = calculate(candidate).score;
          const result = calculate(candidate);
          candidates.push({
            decisions: canonical(candidate),
            score,
            minimum: result.minimumDistrictScore,
            criticalCount: result.criticalCount,
            spent: validate(candidate).budget.spent,
            replacement: { from: decisions[index], to: candidate[index] },
          });
        }
      }
    }
    return { currentScore, candidates };
  }

  function findImprovements(decisions, limit = 3) {
    const { currentScore, candidates } = neighbourhood(decisions);
    return candidates
      .filter((c) => c.score > currentScore + 1e-9)
      .sort(
        (a, b) =>
          b.score - a.score ||
          JSON.stringify(a.decisions).localeCompare(
            JSON.stringify(b.decisions),
          ),
      )
      .slice(0, limit)
      .map((c, i) =>
        clean({
          id: `alternative-${i + 1}`,
          replacement: c.replacement,
          gainOverCurrent: c.score - currentScore,
          simulation: evaluate(c.decisions),
        }),
      );
  }

  function risks(simulation) {
    const result = [];
    for (const d of simulation.districts) {
      for (const k of keys) {
        if (d.after[k] < data.criticalThreshold)
          result.push({
            id: `critical:${d.id}:${k}`,
            type: "critical",
            severity: "high",
            districtId: d.id,
            indicatorId: k,
            value: d.after[k],
            threshold: data.criticalThreshold,
            message: `В районе ${d.name} сохраняется критическое значение: ${data.indicators[k].name}.`,
          });
        else if (d.after[k] < data.criticalThreshold + 5)
          result.push({
            id: `fragile:${d.id}:${k}`,
            type: "near-threshold",
            severity: "medium",
            districtId: d.id,
            indicatorId: k,
            value: d.after[k],
            threshold: data.criticalThreshold,
            message: `В районе ${d.name} показатель «${data.indicators[k].name}» близок к критическому порогу.`,
          });
        if (d.deltas[k] < 0)
          result.push({
            id: `decline:${d.id}:${k}`,
            type: "negative-effect",
            severity: "medium",
            districtId: d.id,
            indicatorId: k,
            delta: d.deltas[k],
            message: `В районе ${d.name} ухудшается показатель «${data.indicators[k].name}».`,
          });
      }
    }
    if (simulation.budget.remaining < data.budget * 0.1)
      result.push({
        id: "low-reserve",
        type: "reserve",
        severity: "medium",
        value: simulation.budget.remaining,
        message:
          "Остаётся небольшой бюджетный резерв. Это аналитическое замечание, остаток не влияет на формулу Score.",
      });
    for (const measure of simulation.measures.filter(
      (m) => m.realizedFraction <= 0.5,
    ))
      result.push({
        id: `lag:${measure.measureId}`,
        type: "lag",
        severity: "medium",
        measureId: measure.measureId,
        realizedFraction: measure.realizedFraction,
        message: `У меры «${measure.name}» в горизонте симуляции реализуется не более половины полного эффекта.`,
      });
    return result;
  }

  function strategies(decisions) {
    const current = evaluate(decisions);
    const { candidates } = neighbourhood(decisions);
    const currentCandidate = {
      decisions: current.decisions,
      score: current.score,
      minimum: current.formula.minimumDistrictScore,
      criticalCount: current.formula.criticalCount,
      spent: current.budget.spent,
      replacement: null,
    };
    const options = [currentCandidate, ...candidates];
    const tie = (a, b) =>
      a.spent - b.spent ||
      JSON.stringify(a.decisions).localeCompare(JSON.stringify(b.decisions));
    const quality = [...options].sort(
      (a, b) => b.score - a.score || tie(a, b),
    )[0];
    const equity = options
      .filter((c) => c.criticalCount <= current.formula.criticalCount)
      .sort(
        (a, b) => b.minimum - a.minimum || b.score - a.score || tie(a, b),
      )[0];
    const reserve = options
      .filter(
        (c) =>
          c.score >= current.score - 1e-9 &&
          c.criticalCount <= current.formula.criticalCount,
      )
      .sort((a, b) => a.spent - b.spent || b.score - a.score || tie(a, b))[0];
    return [
      { id: "quality", title: "Качество жизни", candidate: quality },
      { id: "equity", title: "Поддержка слабой зоны", candidate: equity },
      { id: "reserve", title: "Бюджетный резерв", candidate: reserve },
    ].map(({ id, title, candidate }) => {
      const simulation = evaluate(candidate.decisions);
      return clean({
        id,
        title,
        searchScope:
          "Замена или перенос не более одного решения; глобальный оптимум не гарантируется.",
        changed:
          JSON.stringify(simulation.decisions) !==
          JSON.stringify(current.decisions),
        replacement: candidate.replacement,
        scoreGain: simulation.score - current.score,
        reserveGain: simulation.budget.remaining - current.budget.remaining,
        weakestDistrictGain:
          simulation.formula.minimumDistrictScore -
          current.formula.minimumDistrictScore,
        simulation,
        risks: risks(simulation),
      });
    });
  }

  return {
    validate,
    evaluate,
    findImprovements,
    risks,
    strategies,
    catalog: () => ({
      ...structuredClone(data),
      datasetVersion,
      baseline: clean(base),
    }),
  };
}
