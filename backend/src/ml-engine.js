import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export class MlError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function resolvePython() {
  const bundled = join(homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
  const candidates = process.env.PYTHON_BIN
    ? [{ executable: process.env.PYTHON_BIN, args: [] }]
    : [
        ...(existsSync(bundled) ? [{ executable: bundled, args: [] }] : []),
        { executable: "python", args: [] },
        { executable: "python3", args: [] },
        { executable: "py", args: ["-3"] },
      ];
  for (const candidate of candidates) {
    const check = spawnSync(candidate.executable, [...candidate.args, "-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"], { timeout: 5000, windowsHide: true, stdio: "ignore" });
    if (check.status === 0) return candidate;
  }
  throw new MlError("ML_UNAVAILABLE", "Нужен Python 3.10+. Укажите путь к python.exe в PYTHON_BIN.");
}

export function createMlRunner(python = resolvePython()) {
  const bridge = fileURLToPath(new URL("../../ml/bridge.py", import.meta.url));
  // Python receives the dataset only; the OpenAI credential is unnecessary here.
  const env = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" };
  delete env.OPENAI_API_KEY;
  return (scenarios) => {
    const child = spawnSync(python.executable, [...python.args, bridge], {
      input: JSON.stringify({ scenarios }), encoding: "utf8", env,
      timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    if (child.error || child.status !== 0) {
      throw new MlError("ML_UNAVAILABLE", "Python-модуль не завершил расчёт. Проверьте Python и ml/simulator.py.");
    }
    try {
      const results = JSON.parse(child.stdout);
      if (!Array.isArray(results) || results.length !== scenarios.length) throw new Error();
      return results;
    } catch {
      throw new MlError("ML_INVALID_OUTPUT", "Python-модуль вернул некорректный результат.");
    }
  };
}

export function verifyMlResult(simulation, ml) {
  const near = (a, b) => typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 0.005001;
  const matches = ml?.valid === true
    && near(simulation.score, ml.score)
    && near(simulation.baselineScore, ml.baseline_score)
    && simulation.budget.spent === ml.total_cost
    && simulation.budget.remaining === ml.remaining_budget
    && simulation.formula.criticalCount === ml.critical_count
    && near(simulation.formula.weightedAverage, ml.city_average)
    && simulation.districts.every(d => near(d.score, ml.district_scores?.[d.name])
      && Object.entries(d.after).every(([k, v]) => near(v, ml.indicators?.[d.name]?.[k])));
  if (!matches) throw new MlError("ML_RESULT_MISMATCH", "Расчёты backend и ML расходятся. Результат заблокирован; проверьте версии датасета и формулы.");
  return { ...simulation, ml: {
    status: "verified", engine: "Python · ml/simulator.py", score: ml.score,
    categoryScores: ml.category_scores, strengths: ml.strengths ?? [],
    recommendations: ml.recommendations ?? [],
    note: "Детерминированный расчёт команды ML, не обученная нейросеть. Совпадение проверено с точностью округления Python до сотых.",
  } };
}

export function createIntegratedEngine(engine, run = createMlRunner()) {
  const verified = (simulations) => {
    const results = run(simulations.map(s => s.decisions));
    return simulations.map((s, i) => verifyMlResult(s, results[i]));
  };
  return {
    ...engine,
    evaluate(decisions) { return verified([engine.evaluate(decisions)])[0]; },
    strategies(decisions) {
      const strategies = engine.strategies(decisions);
      const simulations = verified(strategies.map(s => s.simulation));
      return strategies.map((s, i) => ({ ...s, simulation: simulations[i] }));
    },
    findImprovements(decisions, limit) {
      const candidates = engine.findImprovements(decisions, limit);
      if (!candidates.length) return [];
      const simulations = verified(candidates.map(c => c.simulation));
      return candidates.map((c, i) => ({ ...c, simulation: simulations[i] }));
    },
    mlStatus: "connected",
  };
}
