import { createHash } from 'node:crypto';

// В документе используются тысячи тенге. Переносим десятичные строки точно,
// не складываем родительские функциональные группы с вложенными программами.
export function thousandsToKzt(value) {
  const normalized = String(value).replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  const match = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(normalized);
  if (!match) throw new Error('Некорректная сумма в тысячах тенге.');
  const result = (BigInt(match[2]) * 1000n + BigInt((match[3] || '').padEnd(3, '0'))) * (match[1] ? -1n : 1n);
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Сумма превышает точность расчёта.');
  return Number(result);
}
const group = (code, name, sourceThousands) => ({ id: `group-${code}`, code, name, sourceThousands, amountKzt: thousandsToKzt(sourceThousands) });
const program = (code, groupCode, name, sourceThousands) => ({ id: `program-${code}`, code, groupCode, name, sourceThousands, amountKzt: thousandsToKzt(sourceThousands) });

export const budgetSource = {
  id: 'petropavlovsk-budget-2026-july',
  city: 'Петропавловск', year: 2026,
  title: 'Бюджет Петропавловска: уточнение от 9 июля 2026 года',
  originalDecision: '22.12.2025 № 1/30', amendment: '09.07.2026 № 1/36',
  revisionDate: '2026-07-09', checkedAt: '2026-10-07',
  primaryUrl: 'https://adilet.zan.kz/rus/docs/G25SA00130M',
  amendmentPrimaryUrl: 'https://adilet.zan.kz/rus/docs/G26SA00136M',
  readUrl: 'https://adilet.kz/ru/laws/22-2025-no-130-2026-2028/',
  userUrl: 'https://adilet.kz/ru/laws/ob-utverzhdenii-byudzheta-goroda-petropavlovska-na-2026-2028-22-12-2025-no-1-30/',
  sourceUnit: 'тысяч тенге', outputUnit: 'KZT',
  extraction: 'Ручной перенос итогов и таблицы приложения из доступного текста уточнения на adilet.kz. Общие итоги совпадают с индексированным текстом ИПС «Әділет».',
  verificationNote: 'Полный первичный файл ЭКБ не был получен. Подробные строки требуют сверки с первичным документом; отсутствие более поздних изменений не установлено. Это фиксированный срез, не онлайн-проверка актуальности.',
  coverageNote: 'В приложение перенесён только бюджет на 2026 год. Суммы на 2027–2028 годы пока не импортированы.',
  totals: {
    revenueKzt: thousandsToKzt('104 170 716,3'),
    expenditureKzt: thousandsToKzt('110 418 181,0'),
    taxKzt: thousandsToKzt('66 425 993,0'),
    nonTaxKzt: thousandsToKzt('1 057 990,7'),
    capitalSalesKzt: thousandsToKzt('17 149 549,7'),
    transfersInKzt: thousandsToKzt('19 537 182,9'),
    netLendingKzt: thousandsToKzt('-350 000,0'),
    // Знак берётся из итоговой таблицы приложения, а не спорного знака в преамбуле.
    balanceKzt: thousandsToKzt('-5 897 464,7'),
    financingKzt: thousandsToKzt('5 897 464,7'),
    borrowingKzt: thousandsToKzt('13 768 510,0'),
    debtPrincipalKzt: thousandsToKzt('9 505 652,0'),
    usedBalancesKzt: thousandsToKzt('1 634 606,7'),
    executiveReserveKzt: thousandsToKzt('1 338 831,0'),
  },
  groups: [
    group('01', 'Государственные услуги общего характера', '2 861 480,1'),
    group('02', 'Оборона', '111 505,0'),
    group('03', 'Общественный порядок и безопасность', '374 450,0'),
    group('06', 'Социальная помощь и обеспечение', '3 937 955,0'),
    group('07', 'Жилищно-коммунальное хозяйство', '41 010 915,5'),
    group('08', 'Культура, спорт и информационное пространство', '1 343 782,3'),
    group('10', 'Сельское хозяйство, экология и земельные отношения', '390 714,0'),
    group('11', 'Архитектура и строительство', '1 721 304,9'),
    group('12', 'Транспорт и коммуникации', '10 247 899,0'),
    group('13', 'Прочие', '3 206 019,2'),
    group('14', 'Обслуживание долга', '708 024,0'),
    group('15', 'Трансферты', '44 504 132,0'),
  ],
  // Только отдельные вложенные строки; этот список не является полным каталогом.
  programs: [
    program('458-015', '07', 'Освещение улиц', '1 739 553,4'),
    program('458-012', '07', 'Водоснабжение и водоотведение: функционирование', '1 513 132,0'),
    program('458-018', '07', 'Благоустройство и озеленение', '8 093 585,5'),
    program('458-045', '12', 'Капитальный и средний ремонт дорог и улиц', '2 000 000,0'),
    program('458-037', '12', 'Субсидирование пассажирских перевозок', '3 500 000,0'),
    program('459-012', '13', 'Резерв местного исполнительного органа', '1 338 831,0'),
  ],
  boundaries: [
    'Утверждённые затраты уже распределены по бюджетным программам. Они не являются свободными средствами для нового портфеля.',
    'Резерв исполнительного органа уже включён в затраты. Используемые остатки — источник финансирования, а не подтверждённый будущий свободный остаток.',
    'Лимит сценария задаётся пользователем отдельно. Сравнение с программой не разрешает перераспределение её средств.',
    'Документ содержит плановые ассигнования, а не фактическое исполнение, стоимость конкретных учебных проектов или измеренный эффект.',
    'Сметы, содержание, вероятности ущерба и выгода мероприятий остаются допущениями. Бюджетное решение не подтверждает их окупаемость.',
  ],
};

export function validateBudgetSource(data = budgetSource) {
  const t = data.totals;
  if (data.groups.reduce((sum, g) => sum + g.amountKzt, 0) !== t.expenditureKzt) throw new Error('Итоги функциональных групп не совпадают с затратами.');
  if (t.taxKzt + t.nonTaxKzt + t.capitalSalesKzt + t.transfersInKzt !== t.revenueKzt) throw new Error('Итоги доходов не совпадают.');
  if (t.revenueKzt - t.expenditureKzt - t.netLendingKzt !== t.balanceKzt || t.financingKzt !== -t.balanceKzt) throw new Error('Нарушен баланс бюджетной таблицы.');
  if (t.borrowingKzt - t.debtPrincipalKzt + t.usedBalancesKzt !== t.financingKzt) throw new Error('Не совпадают источники финансирования.');
  return true;
}
validateBudgetSource();
budgetSource.fingerprint = createHash('sha256').update(JSON.stringify(budgetSource)).digest('hex').slice(0, 16);
