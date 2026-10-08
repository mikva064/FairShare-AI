import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export function loadConfig(env = process.env, envPath = resolve(projectRoot, '.env')) {
  const local = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
  const value = key => env[key] !== undefined ? env[key] : local[key];
  let key = value('OPENAI_API_KEY');
  const inheritedFile = value('OPENAI_ENV_FILE')?.trim();
  let configurationWarning = null;
  if (key === undefined && inheritedFile) {
    const path = resolve(dirname(envPath), inheritedFile);
    if (existsSync(path)) key = parseEnv(readFileSync(path, 'utf8')).OPENAI_API_KEY;
    else configurationWarning = 'Файл, указанный в OPENAI_ENV_FILE, не найден.';
  }
  const port = Number(value('PORT') || 5181);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT должен быть числом от 1 до 65535.');
  const model = value('OPENAI_MODEL')?.trim() || 'gpt-5-mini';
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(model)) throw new Error('Некорректное имя OPENAI_MODEL.');
  return { port, apiKey: key?.trim() || '', model, configurationWarning };
}
