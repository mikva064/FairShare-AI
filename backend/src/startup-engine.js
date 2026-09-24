import { readFileSync } from 'node:fs';
import { createEngine } from './engine.js';
import { createIntegratedEngine } from './ml-engine.js';

export function loadVerifiedEngine() {
  const path = process.env.DATASET_PATH || new URL('../data/city.json', import.meta.url);
  const engine = createIntegratedEngine(createEngine(JSON.parse(readFileSync(path, 'utf8'))));
  engine.evaluate(engine.catalog().exampleDecisions);
  return engine;
}
export function startupMessage(error) {
  if (error?.code?.startsWith('ML_')) return error.code + ': ' + error.message + ' Проверьте Python 3.10+ и PYTHON_BIN в backend/.env.';
  return 'Не удалось загрузить данные симулятора. Проверьте DATASET_PATH и целостность backend/data/city.json.';
}
