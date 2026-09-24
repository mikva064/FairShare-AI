import type { Catalog, Decision, Simulation } from './api';

export function RegionPanel({ catalog, result, disabled, onSelect }: {
  catalog: Catalog; result: Simulation | null; disabled: boolean; onSelect: (decisions: Decision[]) => void;
}) {
  const { profile } = catalog;
  return <section className="region-panel" aria-label="Петропавловск: контекст и сценарии">
    <div className="data-notice"><strong>Учебный прототип, не официальный цифровой двойник</strong><p>{profile.dataNote}</p></div>
    <div className="preset-heading"><div><p className="label">С чего начать</p><h2>Выберите задачу города</h2></div><span className="hint">Набор можно изменить до расчёта</span></div>
    <div className="preset-grid">{profile.presets.map((preset, index) => <button className="preset-card" key={preset.id} disabled={disabled} onClick={() => onSelect(preset.decisions)} aria-label={'Сценарий: ' + preset.name}>
      <span className="preset-number">0{index + 1}</span><strong>{preset.name}</strong><span>{preset.description}</span>
    </button>)}</div>
    <details className="region-details"><summary>Источники, учебные зоны и ограничения модели</summary>
      <p className="hint">{profile.zoneNote} Баллы ниже — {result ? 'результат выбранного сценария' : 'исходные значения модели'}, а не оценка фактического состояния города.</p>
      <div className="zone-grid">{(result?.districts ?? catalog.baseline.districts).map(zone => <article className="zone-card" key={zone.id}><span>{zone.name}</span><strong>{zone.score.toFixed(2)}</strong><meter min={0} max={100} value={zone.score} aria-label={'Учебный индекс: ' + zone.name} /></article>)}</div>
      <p>Почему выбраны эти темы</p>
      <div className="source-grid">{profile.sources.map(source => <article key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title} ↗</a><p>{source.summary}</p><small>Проверено: {source.accessedAt}</small></article>)}</div>
      <p className="hint">Источники объясняют выбор тем, но не подтверждают баллы и эффекты мер. Прототип не связан с организаторами мероприятия, не прогнозирует паводки и не заменяет экспертизу городских служб.</p>
    </details>
  </section>;
}
