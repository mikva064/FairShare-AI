import express from "express";
import { z } from "zod";
import { ScenarioError } from "./engine.js";
import { AgentError } from "./agent.js";
import { MlError } from "./ml-engine.js";
import { createConversations, ConversationError } from "./conversations.js";

const decision = z
  .object({
    measureId: z.string().min(1).max(16),
    districtId: z.string().min(1).max(32).nullable().optional(),
  })
  .strict();
const scenario = z.object({ decisions: z.array(decision).max(10) }).strict();
const analysisRequest = scenario.extend({
  question: z.string().max(1500).optional(),
});
const comparison = z
  .object({
    scenarios: z
      .array(scenario.extend({ name: z.string().min(1).max(80) }))
      .min(2)
      .max(3),
  })
  .strict();

export function createApp({
  engine,
  agent = null,
  origins = [],
  aiRequestsPerMinute = 5,
}) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    if (origins.includes(req.headers.origin)) {
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    } else if (req.headers.origin)
      return res
        .status(403)
        .json({
          error: {
            code: "ORIGIN_NOT_ALLOWED",
            message: "Этот адрес сайта не включён в FRONTEND_ORIGINS.",
          },
        });
    if (req.method === "OPTIONS") return res.sendStatus(204);
    if (req.method === "POST" && !req.is("application/json"))
      return res
        .status(415)
        .json({
          error: {
            code: "JSON_REQUIRED",
            message: "Требуется Content-Type: application/json.",
          },
        });
    next();
  });
  app.use(express.json({ limit: "24kb" }));
  app.get("/", (_req, res) =>
    res.json({
      name: "Qyzyljar AI — Советник акима",
      api: "/api/catalog",
      health: "/api/health",
    }),
  );
  app.get("/api/health", (_req, res) =>
    res.json({
      ok: true,
      datasetVersion: engine.catalog().datasetVersion,
      aiConfigured: Boolean(agent),
      mlStatus: engine.mlStatus ?? "not-connected",
    }),
  );
  app.get("/api/catalog", (_req, res) => res.json(engine.catalog()));
  app.post("/api/validate", (req, res) => {
    const body = scenario.parse(req.body);
    res.json(engine.validate(body.decisions));
  });
  app.post("/api/simulate", (req, res) =>
    {
      const simulation = engine.evaluate(scenario.parse(req.body).decisions);
      res.json({ ...simulation, risks: engine.risks(simulation) });
    },
  );
  app.post("/api/strategies", (req, res) =>
    res.json({
      strategies: engine.strategies(scenario.parse(req.body).decisions),
    }),
  );
  app.post("/api/compare", (req, res) => {
    const { scenarios } = comparison.parse(req.body);
    const results = scenarios.map((s) => ({
      name: s.name,
      simulation: engine.evaluate(s.decisions),
    }));
    const bestScore = Math.max(...results.map((r) => r.simulation.score));
    res.json({
      datasetVersion: engine.catalog().datasetVersion,
      results: results.map((r) => ({
        ...r,
        risks: engine.risks(r.simulation),
      })),
      bestIndexes: results.flatMap((r, i) =>
        Math.abs(r.simulation.score - bestScore) < 1e-9 ? [i] : [],
      ),
    });
  });
  const conversations = createConversations({ engine });
  const turnRequest = z.object({
    message: z.string().trim().min(1).max(1500),
    priority: z.enum(['quality', 'equity', 'reserve']).optional(),
    revision: z.number().int().nonnegative(),
    requestId: z.string().uuid(),
  }).strict();
  const applyRequest = z.object({
    strategyId: z.enum(['quality', 'equity', 'reserve']),
    revision: z.number().int().nonnegative(),
    requestId: z.string().uuid(),
  }).strict();
  const buckets = new Map();
  let activeAnalyses = 0;
  async function paid(req, res, run) {
    const now = Date.now();
    for (const [key, value] of buckets) if (value.expires <= now) buckets.delete(key);
    const key = req.ip;
    const bucket = buckets.get(key) ?? { count: 0, expires: now + 60000 };
    if (bucket.count >= aiRequestsPerMinute || activeAnalyses >= 2) {
      res.setHeader('Retry-After', '60');
      throw new ConversationError('AI_RATE_LIMIT', 'Слишком много запросов анализа. Повторите через минуту.', 429);
    }
    bucket.count++;
    buckets.set(key, bucket);
    activeAnalyses++;
    try { return await run(); }
    finally { activeAnalyses--; }
  }
  app.post('/api/analyze', async (req, res, next) => {
    try {
      const body = analysisRequest.parse(req.body);
      const simulation = engine.evaluate(body.decisions);
      if (!agent) return res.status(503).json({
        error: { code: 'AI_NOT_CONFIGURED', message: 'Укажите OPENAI_API_KEY на сервере. Числовая симуляция доступна без ключа.' },
        simulation, analysis: { status: 'unavailable' },
      });
      const report = await paid(req, res, () => agent.analyze(body));
      res.json({ ...report, conversation: conversations.create(report, body.question) });
    } catch (error) { next(error); }
  });
  app.post('/api/conversations/:id/messages', async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const body = turnRequest.parse(req.body);
      if (!agent) throw new ConversationError('AI_NOT_CONFIGURED', 'ИИ не настроен. Добавьте серверный ключ и начните новый анализ.', 503);
      const result = await conversations.message(id, body, input => paid(req, res, () => agent.analyze(input)));
      res.json(result);
    } catch (error) { next(error); }
  });
  app.post('/api/conversations/:id/apply', (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      res.json(conversations.apply(id, applyRequest.parse(req.body)));
    } catch (error) { next(error); }
  });
  app.use((_req, res) =>
    res
      .status(404)
      .json({ error: { code: "NOT_FOUND", message: "Маршрут не найден." } }),
  );
  app.use((error, _req, res, _next) => {
    if (error instanceof ConversationError) return res.status(error.status).json({ error: { code: error.code, message: error.message } });
    if (error instanceof MlError)
      return res.status(503).json({ error: { code: error.code, message: error.message } });
    if (error instanceof ScenarioError)
      return res
        .status(422)
        .json({
          error: { code: "INVALID_SCENARIO", message: error.message },
          ...error.validation,
          score: null,
        });
    if (error instanceof z.ZodError)
      return res
        .status(400)
        .json({
          error: {
            code: "INVALID_REQUEST",
            message: "Проверьте формат запроса.",
            details: error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          },
        });
    if (error.type === "entity.parse.failed")
      return res
        .status(400)
        .json({
          error: { code: "INVALID_JSON", message: "Некорректный JSON." },
        });
    if (error.type === "entity.too.large")
      return res
        .status(413)
        .json({
          error: {
            code: "REQUEST_TOO_LARGE",
            message: "Слишком большой запрос.",
          },
        });
    if (error instanceof AgentError)
      return res
        .status(502)
        .json({
          error: { code: error.code, message: error.message },
          analysis: { status: "failed" },
        });
    // Do not echo upstream bodies or secrets to the browser/log.
    if (error.status || /OpenAI|API|Timeout|Abort/.test(error.name ?? ""))
      return res
        .status(502)
        .json({
          error: {
            code: "AI_PROVIDER_ERROR",
            message:
              "Сервис ИИ недоступен. Проверьте ключ, доступ к модели и API-баланс на сервере.",
          },
          analysis: { status: "failed" },
        });
    console.error("Request failed:", error.name ?? "Error");
    res
      .status(500)
      .json({
        error: {
          code: "INTERNAL_ERROR",
          message: "Внутренняя ошибка сервера.",
        },
      });
  });
  return app;
}
