import { useRef, useState } from 'react';
import type { AgentReport, Conversation, DialogueResponse, Simulation, Strategy } from './api';
import { request } from './api';

const priorities = [
  { id: 'quality', title: 'Повысить общий Score' },
  { id: 'equity', title: 'Помочь слабой зоне' },
  { id: 'reserve', title: 'Сохранить бюджет' },
] as const;
type Priority = typeof priorities[number]['id'];
type Entry = { role: 'user' | 'assistant'; message?: string; report?: AgentReport; workflow?: boolean };
const isHelpRequest = (message: string) => /^(да[,.!\s]*(помоги(те)?|хочу|помоги(те)? решить)?|помоги(те)?|давай(те)?|хорошо|ок(ей)?|yes)[.!?\s]*$/iu.test(message.trim());

export function ReportView({ report }: { report: AgentReport }) {
  const a = report.analysis;
  return <div className="result-block ai-report">
    <h4>{a.headline}</h4><p>{a.summary}</p>
    <h4>Сильные стороны</h4><ul>{a.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
    <h4>Компромиссы</h4><ul>{a.tradeoffs.map((s, i) => <li key={i}>{s}</li>)}</ul>
    <h4>Анализ рисков от ИИ</h4><ul>{a.risks.map((r, i) => <li key={i}>{r.explanation}</li>)}</ul>
    <h4>Рекомендации</h4><ul>{a.recommendations.map((r, i) => <li key={i}>{priorities.find(p => p.id === r.strategyId)?.title}: {r.reason}</li>)}</ul>
    <p className="hint">{a.limitations}</p>
    {report.usage && <p className="hint">Запросов модели: {report.usage.modelRequests}. {report.usage.estimatedUsd != null ? 'Оценка стоимости ответа: $' + report.usage.estimatedUsd.toFixed(4) : 'Стоимость уточните у провайдера.'}</p>}
    <p>{a.nextQuestion}</p>
  </div>;
}

export function AdvisorDialogue({ initial, disabled, onBusy, onResult, onApply }: {
  initial: AgentReport & { conversation: Conversation };
  disabled: boolean;
  onBusy: (value: boolean) => void;
  onResult: (simulation: Simulation, strategies: Strategy[]) => void;
  onApply: (simulation: Simulation) => void;
}) {
  const [conversation, setConversation] = useState(initial.conversation);
  const [entries, setEntries] = useState<Entry[]>([{ role: 'assistant', report: initial }]);
  const [latest, setLatest] = useState<AgentReport | null>(initial);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const sending = useRef(false);
  // Keep the same id on an explicit retry after a lost network response.
  const lastRequest = useRef<{ fingerprint: string; requestId: string } | null>(null);
  function requestId(fingerprint: string) {
    if (lastRequest.current?.fingerprint !== fingerprint) lastRequest.current = { fingerprint, requestId: crypto.randomUUID() };
    return lastRequest.current!.requestId;
  }
  async function send(text: string, priority?: Priority) {
    text = text.trim();
    if (!text || disabled || sending.current) return;
    const free = !priority && isHelpRequest(text);
    if (!free && !window.confirm('Отправить вопрос советнику? Этот ответ использует API-баланс и может включать до четырёх запросов модели.')) return;
    sending.current = true; onBusy(true); setPending(text); setError('');
    const payload = { message: text, ...(priority ? { priority } : {}), revision: conversation.revision };
    try {
      const data = await request<DialogueResponse>('/api/conversations/' + conversation.id + '/messages', {
        ...payload, requestId: requestId(JSON.stringify(payload)),
      });
      setConversation(data.conversation);
      setEntries(old => [...old, { role: 'user', message: text }, { role: 'assistant', message: data.message, report: data.report, workflow: data.kind !== 'analysis' }]);
      if (data.report) { setLatest(data.report); onResult({ ...data.report.simulation, risks: data.report.risks }, data.report.strategies); }
      setMessage(''); lastRequest.current = null;
    } catch (e) { setError((e as Error).message); }
    finally { sending.current = false; onBusy(false); setPending(''); }
  }
  async function apply(strategy: Strategy) {
    if (disabled || sending.current) return;
    if (!window.confirm('Заменить текущий набор решений на вариант «' + strategy.title + '»? Применение проверяется симулятором и не вызывает ИИ.')) return;
    sending.current = true; onBusy(true); setPending('Применяем выбранный вариант…'); setError('');
    const payload = { strategyId: strategy.id, revision: conversation.revision };
    try {
      const data = await request<DialogueResponse>('/api/conversations/' + conversation.id + '/apply', {
        ...payload, requestId: requestId(JSON.stringify({ action: 'apply', ...payload })),
      });
      if (!data.simulation) throw new Error('Сервер не вернул проверенный сценарий.');
      setConversation(data.conversation); setLatest(null);
      setEntries(old => [...old, { role: 'user', message: 'Применить вариант «' + strategy.title + '».' }, { role: 'assistant', message: data.message, workflow: true }]);
      onApply(data.simulation); lastRequest.current = null;
    } catch (e) { setError((e as Error).message); }
    finally { sending.current = false; onBusy(false); setPending(''); }
  }
  return <section id="ai-dialogue" className="advisor-dialogue" aria-label="Диалог с советником">
    <p className="hint">История хранится на сервере до получаса бездействия. Перезагрузка страницы или ручное изменение мер начинают новый диалог. Платных ответов осталось: {conversation.turnsRemaining}.</p>
    <div className="chat-history" role="log" aria-live="polite" aria-relevant="additions">
      {entries.map((entry, i) => <article className={'chat-message ' + entry.role} key={i}>
        <strong>{entry.role === 'user' ? 'Вы' : entry.workflow ? 'Помощник интерфейса · без вызова ИИ' : 'ИИ-советник'}</strong>
        {entry.report ? <ReportView report={entry.report} /> : <p>{entry.message}</p>}
      </article>)}
    </div>
    {pending && <p role="status">Обрабатываем: {pending}</p>}
    {error && <p className="state-text error" role="alert">{error}</p>}
    <div className="chat-actions">
      <button className="filter-btn" disabled={disabled} onClick={() => send('Да, помоги')}>Да, помоги · бесплатно уточнить цель</button>
      {priorities.map(p => <button className="filter-btn" key={p.id} disabled={disabled || conversation.turnsRemaining <= 0}
        onClick={() => send(p.title, p.id)}>{p.title} · ИИ</button>)}
    </div>
    <form onSubmit={e => { e.preventDefault(); void send(message); }}>
      <label htmlFor="follow-up">Продолжить разговор о текущем сценарии</label>
      <textarea id="follow-up" value={message} maxLength={1500} disabled={disabled}
        onChange={e => setMessage(e.target.value)} placeholder="Например: почему резервный вариант лучше для Нуры?" />
      <button className="calc-btn" disabled={disabled || !message.trim() || (conversation.turnsRemaining <= 0 && !isHelpRequest(message))}
        type="submit">Отправить{isHelpRequest(message) ? ' · уточнить цель бесплатно' : ' · платный ответ ИИ'}</button>
    </form>
    {!!latest?.strategies.some(s => s.changed) && <div className="chat-options">
      <h4>Проверенные варианты для применения</h4>
      {latest.strategies.filter(s => s.changed).map(s => <div className="chat-option" key={s.id}>
        <strong>{s.title}</strong>
        <p>Score: {s.simulation.score.toFixed(2)} · расходы: {s.simulation.budget.spent} · остаток: {s.simulation.budget.remaining}</p>
        <button className="filter-btn" disabled={disabled} onClick={() => apply(s)}>Применить вариант · без ИИ</button>
      </div>)}
    </div>}
  </section>;
}
