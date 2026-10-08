import { createHash } from 'node:crypto';
import { MODEL_VERSION, modelInfo } from './catalog.js';

export class InputError extends Error {
  constructor(message) { super(message); this.name = 'InputError'; }
}
const fail = message => { throw new InputError(message); };
const moneyLimit = 1_000_000_000_000;
const number = (v, name, min, max, integer = false) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isSafeInteger(v))) fail(`Некорректное поле «${name}».`);
  return v;
};
const text = (v, name, max = 200) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) fail(`Некорректное поле «${name}».`);
  return v.trim();
};
const rounded = v => Math.round(v);

export function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Нужен объект сценария.');
  const { config, projects, selectedIds } = input;
  if (!config || typeof config !== 'object') fail('Не заданы параметры бюджета.');
  const normalizedConfig = {
    budgetKzt: number(config.budgetKzt, 'Бюджет', 1, moneyLimit, true),
    reserveKzt: number(config.reserveKzt, 'Обязательный резерв', 0, moneyLimit, true),
    futureFloorKzt: number(config.futureFloorKzt, 'Минимум средств в будущем', 0, moneyLimit, true),
    horizonYears: number(config.horizonYears, 'Горизонт', 1, 10, true),
    discountPct: number(config.discountPct, 'Дисконтирование', 0, 50),
    costInflationPct: number(config.costInflationPct, 'Рост эксплуатационных затрат', 0, 50),
    maxProjects: number(config.maxProjects, 'Максимум проектов', 1, modelInfo.maxCatalogSize, true),
    lockedIds: config.lockedIds,
  };
  if (normalizedConfig.reserveKzt > normalizedConfig.budgetKzt || normalizedConfig.futureFloorKzt > normalizedConfig.budgetKzt) fail('Резерв не может превышать весь бюджет.');
  if (!Array.isArray(projects) || !projects.length || projects.length > modelInfo.maxCatalogSize) fail('Нужно от 1 до 15 мероприятий.');
  const catalog = projects.map(p => {
    if (!p || typeof p !== 'object') fail('Неверная запись мероприятия.');
    const id = text(p.id, 'ID', 30);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) fail('ID должен содержать буквы, цифры, дефис или подчёркивание.');
    return {
      id, name: text(p.name, 'Название'), sector: text(p.sector, 'Направление'), zone: text(p.zone, 'Зона'),
      description: text(p.description, 'Описание', 1000), source: text(p.source, 'Основание чисел', 1000),
      costKzt: number(p.costKzt, 'Разовые вложения', 1, moneyLimit, true),
      annualOperatingKzt: number(p.annualOperatingKzt, 'Ежегодное содержание', 0, moneyLimit, true),
      annualSavingKzt: number(p.annualSavingKzt, 'Ежегодная экономия бюджета', 0, moneyLimit, true),
      annualRiskProbability: number(p.annualRiskProbability, 'Годовая вероятность риска', 0, 1),
      damageKzt: number(p.damageKzt, 'Ущерб при событии', 0, moneyLimit, true),
      mitigationPct: number(p.mitigationPct, 'Снижение ущерба', 0, 100),
      startYear: number(p.startYear, 'Год начала эффекта', 1, 10, true),
      impactPoints: number(p.impactPoints, 'Социальный приоритет', 0, 100),
    };
  });
  const ids = new Set(catalog.map(p => p.id));
  if (ids.size !== catalog.length) fail('ID мероприятий не должны повторяться.');
  const validateIds = (v, name) => {
    if (!Array.isArray(v) || v.length > catalog.length || new Set(v).size !== v.length || v.some(id => typeof id !== 'string' || !ids.has(id))) fail(`Некорректный список «${name}».`);
    return [...v].sort();
  };
  normalizedConfig.lockedIds = validateIds(config.lockedIds, 'Обязательные проекты');
  const selection = validateIds(selectedIds, 'Выбранные проекты');
  return { config: normalizedConfig, projects: catalog, selectedIds: selection };
}

function projectFlow(project, config, factor) {
  const years = [];
  for (let year = 1; year <= config.horizonYears; year++) {
    const active = year >= project.startYear;
    const savingsKzt = active ? project.annualSavingKzt * factor : 0;
    const operatingKzt = active ? project.annualOperatingKzt * (1 + config.costInflationPct / 100) ** (year - 1) : 0;
    const avoidedLossKzt = active ? project.annualRiskProbability * project.damageKzt * project.mitigationPct / 100 * factor : 0;
    years.push({ year, savingsKzt, operatingKzt, avoidedLossKzt });
  }
  return years;
}

function scenario(selected, config, factor) {
  const investedKzt = selected.reduce((sum, p) => sum + p.costKzt, 0);
  const flows = selected.map(p => projectFlow(p, config, factor));
  let cashKzt = config.budgetKzt - investedKzt;
  let protectedCashKzt = cashKzt;
  let savingsKzt = 0, operatingKzt = 0, avoidedLossKzt = 0;
  let npvKzt = -investedKzt, discountedBenefit = 0, discountedOperating = 0;
  let cumulativeCash = -investedKzt, cashPaybackYear = null;
  const years = [];
  for (let index = 0; index < config.horizonYears; index++) {
    const year = index + 1;
    const row = { year, savingsKzt: 0, operatingKzt: 0, avoidedLossKzt: 0 };
    for (const flow of flows) for (const key of ['savingsKzt', 'operatingKzt', 'avoidedLossKzt']) row[key] += flow[index][key];
    const netCashKzt = row.savingsKzt - row.operatingKzt;
    cashKzt += netCashKzt;
    protectedCashKzt -= row.operatingKzt;
    cumulativeCash += netCashKzt;
    if (cashPaybackYear === null && cumulativeCash >= 0 && investedKzt > 0) cashPaybackYear = year;
    const discount = (1 + config.discountPct / 100) ** year;
    npvKzt += (netCashKzt + row.avoidedLossKzt) / discount;
    discountedBenefit += (row.savingsKzt + row.avoidedLossKzt) / discount;
    discountedOperating += row.operatingKzt / discount;
    savingsKzt += row.savingsKzt;
    operatingKzt += row.operatingKzt;
    avoidedLossKzt += row.avoidedLossKzt;
    years.push({ ...row, netCashKzt, cashKzt, protectedCashKzt });
  }
  return {
    investedKzt, initialReserveKzt: config.budgetKzt - investedKzt,
    savingsKzt, operatingKzt, avoidedLossKzt,
    grossBenefitKzt: savingsKzt + avoidedLossKzt,
    netEffectKzt: savingsKzt + avoidedLossKzt - operatingKzt - investedKzt,
    npvKzt, cashPaybackYear,
    benefitCostRatio: investedKzt + discountedOperating > 0 ? discountedBenefit / (investedKzt + discountedOperating) : null,
    finalCashKzt: cashKzt, protectedFutureKzt: protectedCashKzt, years,
  };
}

function inspect(selectedIds, projects, config) {
  const selected = projects.filter(p => selectedIds.includes(p.id));
  const base = scenario(selected, config, 1);
  const errors = [];
  if (!selected.length) errors.push('Выберите хотя бы одно мероприятие.');
  if (selected.length > config.maxProjects) errors.push(`Допустимо не больше ${config.maxProjects} мероприятий.`);
  for (const id of config.lockedIds) if (!selectedIds.includes(id)) errors.push(`Обязательное мероприятие ${id} не включено.`);
  if (base.investedKzt > config.budgetKzt) errors.push('Разовые вложения превышают бюджет.');
  if (base.initialReserveKzt < config.reserveKzt) errors.push('После вложений не остаётся обязательного резерва.');
  // Без будущих поступлений резерв должен покрывать содержание и сохранять заданный минимум.
  if (base.protectedFutureKzt < config.futureFloorKzt) errors.push('Резерва недостаточно для содержания на всём горизонте и сохранения будущего минимума.');
  return { selected, base, errors };
}

const clean = value => JSON.parse(JSON.stringify(value, (key, v) => typeof v === 'number' ? (key.endsWith('Kzt') ? rounded(v) : Math.round(v * 1e6) / 1e6) : v));

export function evaluateNormalized(input) {
  const { config, projects, selectedIds } = input;
  const { selected, base, errors } = inspect(selectedIds, projects, config);
  const uncertainty = {
    low: scenario(selected, config, modelInfo.benefitFactors.low),
    base,
    high: scenario(selected, config, modelInfo.benefitFactors.high),
  };
  const impactPoints = selected.reduce((sum, p) => sum + p.impactPoints * Math.max(0, config.horizonYears - p.startYear + 1) / config.horizonYears, 0);
  const warnings = [];
  if (selected.length && base.npvKzt < 0) warnings.push('Расчётный экономический NPV отрицательный. Социальные проекты могут быть нужны и без денежной окупаемости.');
  if (base.avoidedLossKzt > 0) warnings.push('Предотвращённый ущерб входит в ожидаемый экономический эффект, но не считается поступлением денег в бюджет.');
  if (selected.some(p => p.startYear > config.horizonYears)) warnings.push('У некоторых мероприятий эффект начинается после выбранного горизонта.');
  if (selected.some(p => p.annualRiskProbability > 0)) warnings.push('Сумма эффектов предполагает отсутствие двойного счёта ущерба. Пересечение рисков между мероприятиями требует проверки специалистом.');
  const fingerprint = createHash('sha256').update(JSON.stringify({ modelVersion: MODEL_VERSION, ...input })).digest('hex').slice(0, 16);
  return clean({
    valid: errors.length === 0, errors, warnings, modelVersion: MODEL_VERSION, fingerprint,
    selectedIds, selectedCount: selected.length, impactPoints,
    budget: {
      totalKzt: config.budgetKzt, investedKzt: base.investedKzt,
      initialReserveKzt: base.initialReserveKzt, requiredReserveKzt: config.reserveKzt,
      operatingProvisionKzt: base.operatingKzt,
      protectedFutureKzt: base.protectedFutureKzt, requiredFutureKzt: config.futureFloorKzt,
      expectedFutureCashKzt: base.finalCashKzt,
    },
    uncertainty,
    contributions: selected.map(p => {
      const flow = scenario([p], { ...config, budgetKzt: p.costKzt }, 1);
      return { id: p.id, name: p.name, costKzt: p.costKzt, savingsKzt: flow.savingsKzt, operatingKzt: flow.operatingKzt, avoidedLossKzt: flow.avoidedLossKzt, npvKzt: flow.npvKzt };
    }),
    assumptions: [
      'Все суммы в тенге. Разовые вложения происходят в начале, содержание и выгода — в конце каждого года начиная с года запуска.',
      'Содержание дорожает на заданный процент ежегодно; экономия и ущерб заданы в номинальных тенге и не индексируются.',
      'Предотвращённый ущерб = годовая вероятность × ущерб при событии × доля снижения ущерба. Это ожидание, а не гарантированная экономия.',
      'Нижний и верхний сценарии меняют экономию и предотвращённый ущерб на −35% / +35%. Это допущения, не доверительный интервал.',
      'Будущий защищённый остаток = бюджет − вложения − всё содержание. Будущая экономия и предотвращённый ущерб не используются для гарантирования резерва.',
      'Социальный приоритет задан экспертными баллами и учитывает время до запуска; баллы не переводятся в деньги.',
      'Остаточная стоимость, дополнительные поступления, заимствования, налоги, строительное удорожание и пересекающиеся эффекты не моделируются.',
    ],
  });
}

export function evaluate(input) { return evaluateNormalized(normalize(input)); }

export function optimize(input) {
  const normalized = normalize(input);
  const { projects, config } = normalized;
  const objectives = [
    { id: 'social', title: 'Социальный приоритет', description: 'Максимум экспертных баллов с учётом времени до запуска; при равенстве — выше NPV.', value: r => r.impactPoints, tie: r => r.uncertainty.base.npvKzt },
    { id: 'economy', title: 'Экономический эффект', description: 'Максимум расчётного NPV, включая ожидаемый предотвращённый ущерб; при равенстве — выше социальный приоритет.', value: r => r.uncertainty.base.npvKzt, tie: r => r.impactPoints },
    { id: 'reserve', title: 'Резерв на будущее', description: 'Максимум защищённого остатка после содержания; при равенстве — выше социальный приоритет. Как минимум один проект.', value: r => r.budget.protectedFutureKzt, tie: r => r.impactPoints },
  ];
  const best = new Map();
  let examined = 0, feasible = 0;
  const masks = 2 ** projects.length;
  for (let mask = 0; mask < masks; mask++) {
    examined++;
    const ids = projects.filter((_, index) => mask & (1 << index)).map(p => p.id).sort();
    if (!ids.length || ids.length > config.maxProjects || config.lockedIds.some(id => !ids.includes(id))) continue;
    const inspected = inspect(ids, projects, config);
    if (inspected.errors.length) continue;
    feasible++;
    const candidate = {
      selectedIds: ids,
      impactPoints: inspected.selected.reduce((sum, p) => sum + p.impactPoints * Math.max(0, config.horizonYears - p.startYear + 1) / config.horizonYears, 0),
      budget: { protectedFutureKzt: inspected.base.protectedFutureKzt }, uncertainty: { base: inspected.base },
    };
    for (const goal of objectives) {
      const previous = best.get(goal.id);
      if (!previous || goal.value(candidate) > goal.value(previous) || (goal.value(candidate) === goal.value(previous) && goal.tie(candidate) > goal.tie(previous))) best.set(goal.id, candidate);
    }
  }
  return {
    modelVersion: MODEL_VERSION, examined, feasible, complete: true,
    scope: 'Все подмножества текущего каталога, с заданными ограничениями. Оптимальность относится только к этой учебной модели и этим входным данным.',
    strategies: objectives.filter(goal => best.has(goal.id)).map(goal => ({
      id: goal.id, title: goal.title, description: goal.description,
      report: evaluateNormalized({ ...normalized, selectedIds: best.get(goal.id).selectedIds }),
    })),
  };
}
