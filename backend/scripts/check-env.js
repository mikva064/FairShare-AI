import { loadVerifiedEngine, startupMessage } from '../src/startup-engine.js';
try {
  loadVerifiedEngine();
  console.log('Проверка окружения: Python и контрольный расчёт ML работают.');
} catch (error) {
  console.error(startupMessage(error));
  process.exitCode = 1;
}
