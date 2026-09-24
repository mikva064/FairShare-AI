import { randomUUID } from 'node:crypto';

export class ConversationError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; }
}
export const clarificationMessage = 'Что важнее сейчас: повысить общий Score, помочь самой слабой учебной зоне или сохранить бюджетный резерв? Выберите приоритет ниже или напишите свой вопрос.';
const affirmative = /^(да[,.!\s]*(помоги(те)?|хочу|помоги(те)? решить)?|помоги(те)?|давай(те)?|хорошо|ок(ей)?|yes)[.!?\s]*$/iu;
export function isHelpRequest(message) { return affirmative.test(message.trim()); }

function reportText(report) {
  const a = report.analysis;
  return JSON.stringify({ summary: a.summary, risks: a.risks, recommendations: a.recommendations, nextQuestion: a.nextQuestion }).slice(0, 6000);
}
export function createConversations({ engine, now = Date.now, ttlMs = 30 * 60 * 1000, maxSessions = 50, maxTurns = 6 } = {}) {
  const sessions = new Map();
  const prune = () => {
    for (const [id, s] of sessions) if (!s.busy && s.expiresAt <= now()) sessions.delete(id);
  };
  const metadata = s => ({ id: s.id, revision: s.revision, priority: s.priority, turnsRemaining: maxTurns - s.turns, expiresAt: s.expiresAt });
  function append(s, role, content) {
    s.history.push({ role, content });
    s.history = s.history.slice(-8);
  }
  function get(id) {
    prune();
    const s = sessions.get(id);
    if (!s) throw new ConversationError('CONVERSATION_EXPIRED', 'Диалог истёк или сервер перезапущен. Запустите новый ИИ-анализ текущего сценария.', 410);
    return s;
  }
  function begin(id, payload, action) {
    const s = get(id);
    const fingerprint = JSON.stringify({ action, ...payload });
    const cached = s.requests.get(payload.requestId);
    if (cached) {
      if (cached.fingerprint !== fingerprint) throw new ConversationError('REQUEST_ID_REUSED', 'Идентификатор запроса уже использован для другого сообщения.');
      return { cached: structuredClone(cached.result) };
    }
    if (s.busy) throw new ConversationError('CONVERSATION_BUSY', 'Предыдущий ответ ещё готовится. Дождитесь его завершения.');
    if (s.revision !== payload.revision) throw new ConversationError('CONVERSATION_CHANGED', 'Сценарий или диалог уже изменился. Начните новый анализ, чтобы не применять устаревший вариант.');
    if (s.requests.size >= 30) throw new ConversationError('CONVERSATION_LIMIT', 'Диалог достиг лимита сообщений. Начните новый анализ.');
    s.busy = true;
    return { s, fingerprint };
  }
  function finish(s, payload, fingerprint, result) {
    s.revision++;
    s.expiresAt = now() + ttlMs;
    const response = { ...result, conversation: metadata(s) };
    s.requests.set(payload.requestId, { fingerprint, result: structuredClone(response) });
    return response;
  }
  return {
    create(report, question = '') {
      prune();
      if (sessions.size >= maxSessions) {
        const oldest = [...sessions.values()].filter(s => !s.busy).sort((a, b) => a.expiresAt - b.expiresAt)[0];
        if (!oldest) throw new ConversationError('CONVERSATION_CAPACITY', 'Сервер занят. Повторите позже.', 503);
        sessions.delete(oldest.id);
      }
      const s = {
        id: randomUUID(), revision: 0, decisions: structuredClone(report.simulation.decisions),
        report: structuredClone(report), priority: null, turns: 1, history: [], busy: false,
        expiresAt: now() + ttlMs, requests: new Map(),
      };
      append(s, 'user', question || 'Проанализируй выбранный сценарий.');
      append(s, 'assistant', reportText(report));
      sessions.set(s.id, s);
      return metadata(s);
    },
    async message(id, payload, analyze) {
      const pending = begin(id, payload, 'message');
      if (pending.cached) return pending.cached;
      const { s, fingerprint } = pending;
      try {
        if (!payload.priority && isHelpRequest(payload.message)) {
          append(s, 'user', payload.message);
          append(s, 'assistant', clarificationMessage);
          return finish(s, payload, fingerprint, { kind: 'clarification', message: clarificationMessage });
        }
        if (s.turns >= maxTurns) throw new ConversationError('CONVERSATION_TURN_LIMIT', 'Достигнут лимит платных ответов в диалоге. Можно применить готовый вариант или начать новый анализ.');
        const priority = payload.priority ?? s.priority;
        // Neither history, decisions nor numerical results are accepted from the browser.
        const report = await analyze({
          decisions: structuredClone(s.decisions), question: payload.message,
          context: { history: structuredClone(s.history), priority },
        });
        s.report = structuredClone(report);
        s.priority = priority;
        s.turns++;
        append(s, 'user', payload.message);
        append(s, 'assistant', reportText(report));
        return finish(s, payload, fingerprint, { kind: 'analysis', message: report.analysis.summary, report });
      } finally { s.busy = false; }
    },
    apply(id, payload) {
      const pending = begin(id, payload, 'apply');
      if (pending.cached) return pending.cached;
      const { s, fingerprint } = pending;
      try {
        const strategy = s.report?.strategies.find(item => item.id === payload.strategyId && item.changed);
        if (!strategy) throw new ConversationError('STRATEGY_UNAVAILABLE', 'Этот вариант уже устарел или не меняет сценарий. Запросите новое сравнение.');
        const checked = engine.evaluate(strategy.simulation.decisions);
        const simulation = { ...checked, risks: engine.risks(checked) };
        s.decisions = structuredClone(simulation.decisions);
        s.report = null;
        const message = 'Вариант «' + strategy.title + '» применён и заново проверен симулятором. Можно задать следующий вопрос об обновлённом сценарии.';
        append(s, 'user', 'Применить вариант «' + strategy.title + '».');
        append(s, 'assistant', message + ' Текущие проверенные данные: ' + JSON.stringify({ decisions: s.decisions, score: simulation.score, budget: simulation.budget }));
        return finish(s, payload, fingerprint, { kind: 'applied', message, simulation });
      } finally { s.busy = false; }
    },
  };
}
