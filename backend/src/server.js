import OpenAI from "openai";
import { createCityAgent } from "./agent.js";
import { createApp } from "./app.js";
import { loadVerifiedEngine, startupMessage } from "./startup-engine.js";

let engine;
try { engine = loadVerifiedEngine(); }
catch (error) { console.error(startupMessage(error)); process.exit(1); }
const apiKey = process.env.OPENAI_API_KEY?.trim();
const agent = apiKey
  ? createCityAgent({
      engine,
      client: new OpenAI({ apiKey, timeout: 45000, maxRetries: 0 }),
      model: process.env.OPENAI_MODEL || "gpt-5-mini",
    })
  : null;
const port = Number(process.env.PORT || 3010);
const limit = Number(process.env.AI_REQUESTS_PER_MINUTE || 5);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Некорректный PORT.");
if (!Number.isInteger(limit) || limit < 1 || limit > 100)
  throw new Error("Некорректный AI_REQUESTS_PER_MINUTE.");
const app = createApp({
  engine,
  agent,
  origins: (
    process.env.FRONTEND_ORIGINS ||
    "http://localhost:5180,http://127.0.0.1:5180,http://localhost:3000"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  aiRequestsPerMinute: limit,
});
const host = process.env.HOST || "127.0.0.1";
const server = app.listen(port, host, () => {
  console.log(`Qyzyljar AI backend: http://${host}:${port}`);
  console.log(`Dataset: ${engine.catalog().datasetVersion}`);
  console.log("ML: Python connected; scores are cross-checked before returning results");
  console.log(
    `AI: ${agent ? "configured" : "not configured; set OPENAI_API_KEY in backend/.env"}`,
  );
  process.send?.({ type: 'ready', service: 'backend' });
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE'
    ? `Порт ${port} занят. Остановите предыдущий запуск проекта.`
    : `Не удалось запустить backend (${error.code || 'ошибка сервера'}).`);
  process.exitCode = 1;
  process.disconnect?.();
});
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => server.close(() => process.exit(0)));
