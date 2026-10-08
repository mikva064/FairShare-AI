const $ = selector => document.querySelector(selector);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value);
const money = value => `${fmt(value)} ₸`;
const short = value => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value / 1_000_000)} млн ₸`;
const storageKey = 'fairshare-budget-lab-v1';
let state, catalog, report, search, editingId, aiResult, health, revision = 0, busy = false;

async function request(path, input, timeoutMs = 20_000) {
  const response = await fetch(path, {
    ...(input ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Сервер не выполнил расчёт.');
  return data;
}
function error(message = '') { $('#error').textContent = message; $('#error').hidden = !message; }
function store() {
  try { localStorage.setItem(storageKey, JSON.stringify({ version: catalog.modelInfo.version, input: state })); $('#save-state').textContent = 'Сохранено в этом браузере · данные остаются локально.'; }
  catch { $('#save-state').textContent = 'Браузер не разрешил сохранение. Скачайте расчёт для резервной копии.'; }
}
function setBusy(value, action = 'optimize') {
  busy = value;
  $('#optimize').disabled = value;
  $('#optimize').textContent = value && action === 'optimize' ? 'Сравниваем все пакеты…' : 'Подобрать варианты →';
  $('#config-form button').disabled = value;
  for (const input of $('#config-form').querySelectorAll('input')) input.disabled = value;
  for (const button of [$('#reset'), $('#example'), $('#clear')]) button.disabled = value;
  for (const input of $('#catalog').querySelectorAll('input')) input.disabled = value || Boolean(input.dataset.select && state.config.lockedIds.includes(input.dataset.select));
  for (const button of $('#catalog').querySelectorAll('button')) button.disabled = value;
  $('#reference').disabled = value;
  $('#use-reference').disabled = value || !state.referenceId;
  $('#ai-question').disabled = value;
  $('#analyze').textContent = value && action === 'analyze' ? 'ИИ анализирует…' : 'Спросить ИИ · платно';
  updateAiAvailability();
}
function fillForm() {
  for (const [key, value] of Object.entries(state.config)) if (key !== 'lockedIds') $('#config-form').elements.namedItem(key).value = value;
}
function readForm() {
  if (!$('#config-form').reportValidity()) return false;
  for (const key of Object.keys(state.config)) if (key !== 'lockedIds') state.config[key] = Number($('#config-form').elements.namedItem(key).value);
  return true;
}
function invalidate() {
  revision++;
  report = null; search = null;
  aiResult = null; $('#ai-answer').innerHTML = ''; $('#ai-error').hidden = true;
  $('#strategies').hidden = true;
  $('#details').innerHTML = '';
  $('#export').disabled = true;
  $('#summary').innerHTML = '<div class="panel loading">Параметры изменены. Нажмите «Пересчитать мой выбор» или «Подобрать варианты».</div>';
  updateAiAvailability();
}
async function calculate() {
  if (!readForm()) return;
  const current = ++revision;
  const snapshot = structuredClone(state);
  $('#export').disabled = true;
  error();
  try {
    const result = await request('/api/evaluate', snapshot);
    if (current !== revision) return;
    report = result;
    store(); render();
  } catch (e) {
    if (current !== revision) return;
    report = null; $('#details').innerHTML = ''; $('#summary').innerHTML = '<div class="panel loading">Расчёт не выполнен. Исправьте параметры и пересчитайте.</div>';
    error(e.name === 'TimeoutError' ? 'Сервер не ответил вовремя. Проверьте окно запуска.' : e.message);
  }
}
function renderCatalog() {
  $('#selection-count').textContent = `Выбрано ${state.selectedIds.length} из ${state.config.maxProjects} допустимых · закреплено ${state.config.lockedIds.length}`;
  $('#catalog').innerHTML = state.projects.map(p => {
    const selected = state.selectedIds.includes(p.id), locked = state.config.lockedIds.includes(p.id);
    return `<article class="project-card ${selected ? 'selected' : ''}">
      <div class="project-head"><span class="sector">${escape(p.sector)}</span><label class="selection-label"><input type="checkbox" data-select="${escape(p.id)}" ${selected ? 'checked' : ''} ${locked ? 'disabled' : ''} aria-label="Выбрать ${escape(p.name)}">${selected ? 'Выбрано' : 'Выбрать'}</label></div>
      <h3>${escape(p.name)}</h3><span class="project-zone">${escape(p.zone)}</span>
      <div class="project-price">${escape(short(p.costKzt))}</div>
      <div class="project-meta"><span>Запуск: год ${p.startYear}</span><span>Приоритет: ${fmt(p.impactPoints)} б.</span></div>
      <p>Содержание: ${escape(short(p.annualOperatingKzt))} / год в ценах 1-го года<br>Экономия: ${escape(short(p.annualSavingKzt))} / год после запуска</p>
      <div class="project-bottom"><label class="lock-label"><input type="checkbox" data-lock="${escape(p.id)}" ${locked ? 'checked' : ''}>Обязательный проект</label><button class="text-button" data-edit="${escape(p.id)}">Параметры ↗</button></div>
    </article>`;
  }).join('');
}
function renderSummary() {
  const b = report.budget;
  const capacity = Math.max(b.totalKzt, b.investedKzt + b.operatingProvisionKzt);
  const width = n => Math.max(0, Math.min(100, n / capacity * 100));
  $('#summary').innerHTML = `<div class="summary-grid">
    <article class="panel metric"><p class="metric-label">Разовые вложения</p><p class="metric-value">${escape(short(b.investedKzt))}</p><p class="metric-note">из ${escape(short(b.totalKzt))}</p></article>
    <article class="panel metric"><p class="metric-label">Остаток после вложений</p><p class="metric-value ${b.initialReserveKzt < b.requiredReserveKzt ? 'negative' : ''}">${escape(short(b.initialReserveKzt))}</p><p class="metric-note">обязательный резерв: ${escape(short(b.requiredReserveKzt))}</p></article>
    <article class="panel metric featured"><p class="metric-label">Защищённый остаток через ${state.config.horizonYears} лет</p><p class="metric-value ${b.protectedFutureKzt < b.requiredFutureKzt ? 'negative' : 'positive'}">${escape(short(b.protectedFutureKzt))}</p><p class="metric-note">после содержания, без будущей экономии</p></article>
  </div><div class="panel allocation"><div class="allocation-head"><span>Куда распределяется бюджет</span><span class="${report.valid ? 'good-label' : 'bad-label'}">${report.valid ? '✓ Ограничения соблюдены' : 'Требуется пересмотр'}</span></div>
    <div class="allocation-bar" role="img" aria-label="Вложения ${escape(money(b.investedKzt))}; содержание ${escape(money(b.operatingProvisionKzt))}; будущий остаток ${escape(money(b.protectedFutureKzt))}"><span class="bar-capex" style="width:${width(b.investedKzt)}%"></span><span class="bar-operating" style="width:${width(b.operatingProvisionKzt)}%"></span><span class="bar-future" style="width:${width(b.protectedFutureKzt)}%"></span></div>
    <div class="allocation-legend"><span class="legend-item"><i class="dot bar-capex"></i>Вложения · ${escape(short(b.investedKzt))}</span><span class="legend-item"><i class="dot bar-operating"></i>Содержание · ${escape(short(b.operatingProvisionKzt))}</span><span class="legend-item"><i class="dot bar-future"></i>Будущее · ${escape(short(b.protectedFutureKzt))}</span></div>
    ${report.errors.length ? `<ul class="validation-list">${report.errors.map(e => `<li>• ${escape(e)}</li>`).join('')}</ul>` : ''}
  </div>`;
}
function row(label, value, options = '') { return `<div class="benefit-row ${options}"><span>${escape(label)}</span><strong>${escape(money(value))}</strong></div>`; }
function renderDetails() {
  const base = report.uncertainty.base;
  const maxBenefit = Math.max(1, ...Object.values(report.uncertainty).map(s => s.grossBenefitKzt));
  const years = base.years;
  const social = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(report.impactPoints);
  const ratio = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(base.benefitCostRatio ?? 0);
  $('#details').innerHTML = `<div class="detail-layout">
    <section class="panel detail-panel"><div class="section-label"><span>03</span> Ожидаемая выгода</div><h2>Эффект за ${state.config.horizonYears} лет</h2><p class="detail-subtitle">Экономия + ожидаемый предотвращённый ущерб.<br>Вложения и содержание вычитаются в чистом эффекте.</p>
      <div class="scenario-bars">${[['low', 'Нижний сценарий · −35%'], ['base', 'Базовый сценарий'], ['high', 'Верхний сценарий · +35%']].map(([key, name]) => `<div class="scenario-item"><div class="scenario-name"><span>${name}</span><strong>${escape(short(report.uncertainty[key].grossBenefitKzt))}</strong></div><div class="scenario-track"><div class="scenario-fill" style="width:${report.uncertainty[key].grossBenefitKzt / maxBenefit * 100}%"></div></div></div>`).join('')}</div>
      <div class="benefit-breakdown">${row('Экономия расходов бюджета', base.savingsKzt)}${row('Ожидаемый предотвращённый ущерб', base.avoidedLossKzt)}${row('Содержание за весь срок', -base.operatingKzt)}${row('Разовые вложения', -base.investedKzt)}${row('Чистый экономический эффект', base.netEffectKzt, `total ${base.netEffectKzt < 0 ? 'negative' : ''}`)}${row('NPV с учётом дисконтирования', base.npvKzt, base.npvKzt < 0 ? 'negative' : '')}</div>
      <p class="explanation">На 1 ₸ дисконтированных затрат приходится <strong>${ratio} ₸</strong> расчётной экономической выгоды. Социальный приоритет: <strong>${social} баллов</strong> с учётом срока запуска.<br>Окупаемость только за счёт экономии бюджета: <strong>${base.cashPaybackYear ? `год ${base.cashPaybackYear}` : 'не достигается на этом горизонте'}</strong>.</p>
    </section>
    <section class="panel detail-panel"><div class="section-label"><span>04</span> Деньги на будущие годы</div><h2>Резерв не заканчивается завтра</h2><p class="detail-subtitle">«Защищено» — если экономия не поступит.<br>«Ожидается» — с учётом сценарной экономии бюджета.</p>
      <div class="table-wrap"><table><thead><tr><th>Год</th><th>Содержание</th><th>Экономия</th><th>Защищено</th><th>Ожидается</th></tr></thead><tbody><tr><td>Старт</td><td>—</td><td>—</td><td>${escape(short(base.initialReserveKzt))}</td><td>${escape(short(base.initialReserveKzt))}</td></tr>${years.map(y => `<tr><td>${y.year}</td><td>${escape(short(y.operatingKzt))}</td><td>${escape(short(y.savingsKzt))}</td><td class="${y.protectedCashKzt < state.config.futureFloorKzt ? 'negative' : ''}">${escape(short(y.protectedCashKzt))}</td><td class="${y.cashKzt < 0 ? 'negative' : ''}">${escape(short(y.cashKzt))}</td></tr>`).join('')}</tbody></table></div>
      <p class="table-hint">Для удобства таблица показана в млн ₸. Точные суммы в тенге доступны в скачиваемом расчёте.</p>
      <p class="explanation">Защищённый остаток к концу: <strong>${escape(money(base.protectedFutureKzt))}</strong>.<br>Заданный минимум: <strong>${escape(money(state.config.futureFloorKzt))}</strong>.<br>Вложения и содержание обеспечиваются текущим бюджетом. Будущие дополнительные поступления не предполагаются.</p>
      <details class="contributions"><summary>Вклад каждого мероприятия</summary><div class="table-wrap"><table><thead><tr><th>Мероприятие</th><th>Вложения</th><th>NPV</th></tr></thead><tbody>${report.contributions.map(p => `<tr><td title="${escape(p.name)}">${escape(p.name)}</td><td>${escape(short(p.costKzt))}</td><td class="${p.npvKzt < 0 ? 'negative' : ''}">${escape(short(p.npvKzt))}</td></tr>`).join('')}</tbody></table></div></details>
    </section></div>
    ${report.warnings.length ? `<aside class="warnings"><ul>${report.warnings.map(w => `<li>${escape(w)}</li>`).join('')}</ul></aside>` : ''}`;
  $('#assumptions').innerHTML = `<ul>${report.assumptions.map(a => `<li>${escape(a)}</li>`).join('')}</ul><p>NPV = −вложения + сумма (экономия + предотвращённый ущерб − содержание) / (1 + ставка)^год.</p><p>Выгода / затраты = дисконтированная сумма экономии и предотвращённого ущерба / (вложения + дисконтированное содержание).</p><p>Версия: ${escape(report.modelVersion)} · отпечаток входных данных: ${escape(report.fingerprint)}</p>`;
}
function renderStrategies() {
  if (!search) { $('#strategies').hidden = true; return; }
  $('#strategies').hidden = false;
  $('#strategies').innerHTML = `<div class="section-label"><span>ПОДБОР</span> Три цели распределения</div><h2>${search.strategies.length ? 'Выберите подходящий компромисс' : 'Допустимый пакет не найден'}</h2><p class="search-meta">Перебор завершён: ${fmt(search.examined)} сочетаний, ${fmt(search.feasible)} допустимых. ${search.strategies.length ? 'Варианты могут совпасть.' : 'Уменьшите расходы, число обязательных проектов или требования к резерву.'}</p>
    <div class="strategies-grid">${search.strategies.map(s => `<article class="panel strategy-card"><span class="strategy-label">${escape(s.title)}</span><h3>${s.report.selectedCount} мероприятий</h3><p>${escape(s.description)}</p><div class="strategy-stat"><span>Вложения</span><strong>${escape(short(s.report.budget.investedKzt))}</strong></div><div class="strategy-stat"><span>Будущий остаток</span><strong>${escape(short(s.report.budget.protectedFutureKzt))}</strong></div><div class="strategy-stat"><span>Экономический NPV</span><strong class="${s.report.uncertainty.base.npvKzt < 0 ? 'negative' : ''}">${escape(short(s.report.uncertainty.base.npvKzt))}</strong></div><div class="strategy-stat"><span>Социальный приоритет</span><strong>${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(s.report.impactPoints)} б.</strong></div><div class="strategy-projects">${s.report.selectedIds.map(id => escape(state.projects.find(p => p.id === id).name)).join(' · ')}</div><button class="button secondary full" data-apply="${escape(s.id)}">Применить пакет →</button></article>`).join('')}</div><p class="search-meta">${escape(search.scope)}</p>`;
}
function render() {
  renderCatalog();
  if (report) { renderSummary(); renderDetails(); $('#export').disabled = false; }
  renderStrategies();
  renderReference(); updateAiAvailability();
}

function renderSource() {
  const s = catalog.budgetSource;
  const billion = value => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(value / 1_000_000_000)} млрд ₸`;
  $('#budget-source').innerHTML = `<div class="section-heading"><div><p class="eyebrow">ИСТОЧНИК · ПЛАНОВЫЙ БЮДЖЕТ ГОРОДА</p><h2>Петропавловск · ${s.year}</h2></div><span class="tag">Срез ${escape(s.revisionDate)}</span></div>
    <div class="source-metrics"><div><span>Доходы</span><strong>${escape(billion(s.totals.revenueKzt))}</strong></div><div><span>Затраты</span><strong>${escape(billion(s.totals.expenditureKzt))}</strong></div><div><span>Утверждённый резерв исполнительного органа</span><strong>${escape(billion(s.totals.executiveReserveKzt))}</strong></div></div>
    <p class="source-note">Эти средства уже распределены. Резерв включён в затраты. Лимит нашего сценария ниже задаётся отдельно.</p>
    <details><summary>Распределение, программы и происхождение данных</summary><div class="source-detail-grid"><div><h3>Функциональные группы</h3><div class="table-wrap"><table><thead><tr><th>Группа</th><th>Сумма, ₸</th></tr></thead><tbody>${s.groups.map(g => `<tr><td>${escape(g.code)} · ${escape(g.name)}</td><td>${escape(money(g.amountKzt))}</td></tr>`).join('')}</tbody></table></div></div><div><h3>Отдельные программы внутри групп</h3><div class="table-wrap"><table><thead><tr><th>Программа</th><th>Сумма, ₸</th></tr></thead><tbody>${s.programs.map(p => `<tr><td>${escape(p.name)}</td><td>${escape(money(p.amountKzt))}</td></tr>`).join('')}</tbody></table></div><p class="field-hint">Программы вложены в группы. Повторно к общему итогу их не прибавляем.</p></div></div>
    <div class="method-text"><p>Решение: ${escape(s.originalDecision)}; уточнение: ${escape(s.amendment)}. В документе — тысячи тенге, в приложении — тенге.</p><p>${escape(s.extraction)}</p><p>${escape(s.verificationNote)}</p><p>${escape(s.coverageNote)}</p><p><a href="${escape(s.readUrl)}" target="_blank" rel="noopener noreferrer">Прочитанный текст уточнения</a> · <a href="${escape(s.primaryUrl)}" target="_blank" rel="noopener noreferrer">Первичный документ в ИПС «Әділет»</a></p><ul>${s.boundaries.map(b => `<li>${escape(b)}</li>`).join('')}</ul></div></details>`;
  $('#reference').innerHTML = '<option value="">Без привязки</option>' + s.programs.map(p => `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('');
}
function renderReference() {
  $('#reference').value = state.referenceId || '';
  const p = catalog.budgetSource.programs.find(p => p.id === state.referenceId);
  $('#use-reference').disabled = busy || !p;
  $('#reference-note').textContent = p ? `В источнике: ${money(p.amountKzt)}. Это утверждённые ассигнования, не свободный остаток. ${state.config.budgetKzt > p.amountKzt ? 'Лимит вашего сценария превышает эту сумму.' : 'Сравнение показывает только масштаб.'}` : 'Сравнение показывает масштаб сценария и не подтверждает наличие свободных средств.';
}
function updateAiAvailability() {
  $('#analyze').disabled = busy || !health?.aiConfigured || report?.valid !== true;
  $('#ai-status').textContent = health?.aiConfigured ? 'Ключ настроен' : 'Без ключа доступны расчёты';
  $('#ai-hint').textContent = !health?.aiConfigured ? 'Добавьте ключ в локальный .env и перезапустите сервер. Ключ вводится только на сервере.' : !report?.valid ? 'Пересчитайте корректный сценарий, чтобы открыть AI-анализ.' : 'Один платный запрос. Настроенный ключ ещё не означает, что на API есть баланс.';
}
function renderAiResult() {
  if (!aiResult) return;
  const { answer, facts, sources, usage } = aiResult;
  const evidenceIds = [...new Set([...answer.findings.flatMap(f => f.evidenceIds), ...answer.recommendation.evidenceIds])];
  const titles = { current: 'Текущий выбор', social: 'Социальный приоритет', economy: 'Экономический эффект', reserve: 'Резерв на будущее' };
  $('#ai-answer').innerHTML = `<div class="ai-output"><p class="ai-summary">${escape(answer.summary)}</p><div class="ai-result-grid"><div><h3>Что показывает расчёт</h3><ul>${answer.findings.map(f => `<li>${escape(f.text)}</li>`).join('')}</ul><h3>Риски и ограничения</h3><ul>${answer.risks.map(r => `<li>${escape(r.comment)}</li>`).join('')}</ul></div><div class="ai-recommendation"><p class="eyebrow">РЕКОМЕНДУЕМЫЙ ПАКЕТ</p><h3>${escape(titles[answer.recommendation.strategyId])}</h3><p>${escape(answer.recommendation.reason)}</p>${answer.recommendation.strategyId !== 'current' ? '<button id="apply-ai" class="button secondary full">Применить проверенный пакет · бесплатно</button>' : ''}<h3>Что нужно уточнить</h3><ul>${answer.missingData.map(t => `<li>${escape(t)}</li>`).join('')}</ul></div></div>
    <details class="ai-evidence"><summary>Показатели, на которые ссылается ИИ</summary><div class="table-wrap"><table><thead><tr><th>Основание</th><th>Значение</th><th>Тип данных</th></tr></thead><tbody>${evidenceIds.map(id => { const f = facts.find(f => f.id === id); return `<tr><td>${escape(titles[id.split('.')[0]] || 'Бюджетный источник')} · ${escape(f.label)}</td><td>${escape(f.unit === 'KZT' ? money(f.value) : `${fmt(f.value)} б.`)}</td><td>${f.kind === 'source' ? 'Из бюджетного среза' : 'Расчёт по допущениям'}</td></tr>`; }).join('')}</tbody></table></div></details>
    <div class="ai-sources">${sources.filter(s => answer.sourceIds.includes(s.id)).map(s => `<a href="${escape(s.url)}" target="_blank" rel="noopener noreferrer">${escape(s.title)}</a>`).join(' · ')}<p class="field-hint">${escape(aiResult.model)}${usage ? ` · токены: вход ${fmt(usage.inputTokens)}, выход ${fmt(usage.outputTokens)}` : ''} · суммы взяты из расчётов сервера и источника. Текст рекомендации сформирован моделью.</p></div></div>`;
}

$('#reference').addEventListener('change', () => {
  if (busy) return;
  state.referenceId = $('#reference').value || null;
  invalidate(); renderReference(); calculate();
});
$('#use-reference').addEventListener('click', () => {
  const p = catalog.budgetSource.programs.find(p => p.id === state.referenceId);
  if (!p || busy) return;
  $('#config-form').elements.namedItem('budgetKzt').value = p.amountKzt;
  invalidate(); calculate();
});
$('#ai-form').addEventListener('submit', event => {
  event.preventDefault();
  if (busy || !health?.aiConfigured || !report?.valid || !$('#ai-form').reportValidity()) return;
  $('#ai-confirm').showModal();
});
$('#cancel-ai').addEventListener('click', () => $('#ai-confirm').close());
$('#confirm-ai').addEventListener('click', async () => {
  $('#ai-confirm').close();
  if (busy || !health?.aiConfigured || !report?.valid || !readForm()) return;
  const current = ++revision;
  setBusy(true, 'analyze');
  $('#ai-error').hidden = true;
  aiResult = null; $('#ai-answer').innerHTML = '<p class="loading">Анализируем проверенные варианты и бюджетный контекст…</p>';
  try {
    const result = await request('/api/analyze', { ...structuredClone(state), question: $('#ai-question').value, allowPaid: true }, 80_000);
    if (current !== revision || result.fingerprint !== report.fingerprint) return;
    aiResult = result; search = result.search; renderStrategies(); renderAiResult();
  } catch (e) {
    if (current !== revision) return;
    $('#ai-answer').innerHTML = '';
    $('#ai-error').textContent = e.name === 'TimeoutError' ? 'ИИ не ответил вовремя. Повторный запуск может снова расходовать API-баланс.' : e.message;
    $('#ai-error').hidden = false;
  } finally { setBusy(false); }
});
$('#ai-answer').addEventListener('click', event => {
  if (!event.target.closest('#apply-ai') || busy || !aiResult || aiResult.fingerprint !== report?.fingerprint) return;
  const recommended = aiResult.recommendationReport;
  state.selectedIds = [...recommended.selectedIds];
  invalidate(); report = recommended; store(); render();
  $('#summary').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('#config-form').addEventListener('submit', event => { event.preventDefault(); search = null; calculate(); });
$('#config-form').addEventListener('input', () => { invalidate(); error(); });
$('#catalog').addEventListener('change', event => {
  if (!state || busy) return;
  const id = event.target.dataset.select || event.target.dataset.lock;
  if (!id) return;
  invalidate();
  if (event.target.dataset.lock) {
    state.config.lockedIds = event.target.checked ? [...state.config.lockedIds, id] : state.config.lockedIds.filter(x => x !== id);
    if (event.target.checked && !state.selectedIds.includes(id)) state.selectedIds.push(id);
  } else state.selectedIds = event.target.checked ? [...state.selectedIds, id] : state.selectedIds.filter(x => x !== id);
  renderCatalog(); calculate();
});
$('#catalog').addEventListener('click', event => {
  const id = event.target.closest('[data-edit]')?.dataset.edit;
  if (!id || busy) return;
  editingId = id;
  const p = state.projects.find(p => p.id === id);
  $('#editor-title').textContent = p.name;
  for (const key of ['costKzt', 'annualOperatingKzt', 'annualSavingKzt', 'damageKzt', 'mitigationPct', 'startYear', 'impactPoints', 'source']) $('#project-form').elements.namedItem(key).value = p[key];
  $('#project-form').elements.namedItem('riskPct').value = Math.round(p.annualRiskProbability * 10000) / 100;
  $('#project-dialog').showModal();
});
$('#close-editor').addEventListener('click', () => $('#project-dialog').close());
$('#cancel-editor').addEventListener('click', () => $('#project-dialog').close());
$('#project-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!$('#project-form').reportValidity()) return;
  const p = state.projects.find(p => p.id === editingId);
  for (const key of ['costKzt', 'annualOperatingKzt', 'annualSavingKzt', 'damageKzt', 'mitigationPct', 'startYear', 'impactPoints']) p[key] = Number($('#project-form').elements.namedItem(key).value);
  p.annualRiskProbability = Number($('#project-form').elements.namedItem('riskPct').value) / 100;
  p.source = $('#project-form').elements.namedItem('source').value.trim();
  $('#project-dialog').close(); invalidate(); renderCatalog(); calculate();
});
$('#optimize').addEventListener('click', async () => {
  if (busy || !state || !readForm()) return;
  const current = ++revision;
  setBusy(true); error();
  try {
    const snapshot = structuredClone(state);
    const [currentReport, result] = await Promise.all([request('/api/evaluate', snapshot), request('/api/optimize', snapshot)]);
    if (current !== revision) return;
    report = currentReport; search = result; store(); render();
    $('#strategies').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { if (current === revision) error(e.name === 'TimeoutError' ? 'Сервер не ответил вовремя. Проверьте окно запуска.' : e.message); }
  finally { setBusy(false); }
});
$('#strategies').addEventListener('click', event => {
  const id = event.target.closest('[data-apply]')?.dataset.apply;
  const strategy = search?.strategies.find(s => s.id === id);
  if (!strategy || busy) return;
  state.selectedIds = [...strategy.report.selectedIds];
  aiResult = null; $('#ai-answer').innerHTML = ''; $('#ai-error').hidden = true;
  report = strategy.report; revision++; store(); render();
  $('#summary').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#example').addEventListener('click', () => {
  if (!state || busy) return;
  state.selectedIds = [...new Set([...catalog.exampleIds, ...state.config.lockedIds])];
  invalidate(); renderCatalog(); calculate();
});
$('#clear').addEventListener('click', () => {
  if (!state || busy) return;
  state.selectedIds = [...state.config.lockedIds]; invalidate(); renderCatalog(); calculate();
});
$('#reset').addEventListener('click', () => {
  if (!catalog || busy) return;
  $('#reset-dialog').showModal();
});
$('#cancel-reset').addEventListener('click', () => $('#reset-dialog').close());
$('#confirm-reset').addEventListener('click', () => {
  if (!catalog || busy) return;
  $('#reset-dialog').close();
  state = { config: structuredClone(catalog.defaults), projects: structuredClone(catalog.projects), selectedIds: [...catalog.exampleIds], referenceId: null };
  fillForm(); invalidate(); renderCatalog(); calculate();
});
$('#export').addEventListener('click', () => {
  if (!report) return;
  const artifact = {
    format: 'fairshare-budget-lab-report-v1', exportedAt: new Date().toISOString(),
    dataStatus: 'Числовые параметры — допущения; изменение поля источника не доказывает достоверность.',
    input: state, report, optimization: search, budgetSource: catalog.budgetSource, aiReview: aiResult || null,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(artifact, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `fairshare-budget-${report.fingerprint}.json`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

async function start() {
  try {
    [catalog, health] = await Promise.all([request('/api/catalog'), request('/api/health')]);
    state = { config: structuredClone(catalog.defaults), projects: structuredClone(catalog.projects), selectedIds: [...catalog.exampleIds], referenceId: null };
    let restored = false;
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (saved?.version === catalog.modelInfo.version && saved.input) {
        await request('/api/evaluate', saved.input);
        state = saved.input; restored = true;
        if (!catalog.budgetSource.programs.some(p => p.id === state.referenceId)) state.referenceId = null;
      }
    } catch { /* При повреждённом сохранении используются безопасные исходные параметры. */ }
    renderSource(); fillForm(); renderCatalog(); renderReference(); await calculate();
    if (restored) $('#save-state').textContent = 'Восстановлено из этого браузера · пересчитано сервером.';
  } catch {
    error('Локальный сервер недоступен. Запустите npm.cmd run dev в папке fairshare-budget-lab и обновите страницу.');
    $('#summary').innerHTML = '<div class="panel loading">Не удалось загрузить модель.</div>';
    $('#optimize').disabled = true;
  }
}
start();
