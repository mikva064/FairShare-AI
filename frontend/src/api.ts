export type Decision = { measureId: string; districtId?: string | null };
export type Catalog = {
  budget: number; horizonQuarters: number; decisionsRequired: number; maxPerDirection: number;
  datasetVersion: string; directions: Record<string, string>;
  indicators: Record<string, { name: string }>;
  districts: { id: string; name: string }[];
  measures: { id: string; name: string; direction: string; cost: number; scope: 'city' | 'district'; lagQuarters: number; effects: Record<string, number> }[];
  profile: { city: string; region: string; edition: string; scoreName: string; dataStatus: string; dataNote: string; zoneNote: string;
    sources: { title: string; url: string; summary: string; accessedAt: string }[];
    presets: { id: string; name: string; description: string; decisions: Decision[] }[];
  };
  baseline: { score: number; districts: { id: string; name: string; score: number }[] }; exampleDecisions: Decision[];
};
export type Health = { ok: boolean; aiConfigured: boolean; mlStatus: string };
export type Validation = { valid: boolean; errors: { code: string; message: string }[] };
export type Risk = { id: string; message: string };
export type Simulation = {
  decisions: Decision[]; score: number; baselineScore: number; scoreDelta: number;
  budget: { total: number; spent: number; remaining: number };
  districts: { id: string; name: string; score: number; baselineScore: number; scoreDelta: number }[];
  risks?: Risk[];
  ml?: { status: string; score: number; strengths: string[]; recommendations: string[] };
};
export type Strategy = {
  id: string; title: string; changed: boolean; scoreGain: number; simulation: Simulation; risks: Risk[];
  replacement: { from: Decision; to: Decision } | null;
};
export type Conversation = { id: string; revision: number; priority: 'quality' | 'equity' | 'reserve' | null; turnsRemaining: number; expiresAt: number };
export type DialogueResponse = { conversation: Conversation; kind: 'clarification' | 'analysis' | 'applied'; message: string; report?: AgentReport; simulation?: Simulation };
export type AgentReport = {
  conversation?: Conversation;
  simulation: Simulation; strategies: Strategy[]; risks: Risk[];
  analysis: { headline: string; summary: string; strengths: string[]; tradeoffs: string[];
    risks: { evidenceId: string; explanation: string }[];
    recommendations: { strategyId: string; reason: string }[]; limitations: string; nextQuestion: string;
  };
  usage?: { inputTokens: number; outputTokens: number; modelRequests: number; estimatedUsd: number | null };
};

export class ApiError extends Error {
  constructor(message: string, public code: string, public retryable = false) { super(message); }
}

export async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, path === '/api/analyze' || /^\/api\/conversations\/[^/]+\/messages$/.test(path) ? 100000 : 20000);
  try {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const isJson = /\bapplication\/(?:[\w.-]+\+)?json\b/i.test(response.headers.get('content-type') ?? '');
    if (!isJson) {
      if (response.ok) throw new ApiError(
        'Вместо API получена страница сайта. Проверьте proxy /api и запустите npm.cmd run dev из корня проекта. Проверьте, что запущен Qyzyljar AI, а не старая сборка SteppeX.',
        'API_PROXY_MISSING',
      );
      throw new ApiError(
        'Backend не дал JSON-ответ (HTTP ' + response.status + '). Проверьте его запуск на порту 3010 и ошибки в терминале.',
        'BACKEND_UNAVAILABLE', response.status >= 500,
      );
    }
    let data;
    try { data = await response.json(); }
    catch { throw new ApiError('API вернул повреждённый JSON (HTTP ' + response.status + ').', 'INVALID_API_JSON'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new ApiError('API вернул неожиданный формат данных. Проверьте версию backend.', 'INVALID_API_RESPONSE');
    }
    if (!response.ok) {
      const details = Array.isArray(data.errors) ? data.errors.map((e: { message?: string }) => e?.message).filter(Boolean).join(' ') : '';
      throw new ApiError(details || data.error?.message || 'Ошибка запроса: ' + response.status,
        data.error?.code || 'HTTP_ERROR', response.status >= 500);
    }
    return data as T;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timedOut) throw new ApiError('Сервер не ответил вовремя. Проверьте терминал запуска проекта.', 'REQUEST_TIMEOUT', true);
    if (error instanceof ApiError) throw error;
    throw new ApiError('Нет соединения с сервером. Откройте сайт через http://127.0.0.1:5180 после запуска проекта.', 'NETWORK_ERROR', true);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

// Retry only read-only startup requests, never a paid analysis or simulation.
export async function requestStartup<T>(path: '/api/catalog' | '/api/health', signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await request<T>(path, undefined, signal); }
    catch (error) {
      if (signal.aborted || attempt >= 3 || !(error instanceof ApiError) || !error.retryable) throw error;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('Подключение отменено.')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 750 * (attempt + 1));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
}
