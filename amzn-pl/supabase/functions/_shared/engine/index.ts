/**
 * Amazon P&L engine.
 * Чистый TypeScript без зависимостей от рантайма (работает в Deno и Node).
 * Формулы переносятся сюда из frontend/Excel 1:1 и фиксируются golden-тестами.
 *
 * ВАЖНО: конкретные формулы ниже — КАРКАС с типовой структурой Amazon P&L.
 * При переносе реального проекта каждая формула сверяется с Excel-моделью
 * заказчика и покрывается golden-тестом (см. engine/tests).
 *
 * Инвариант, который держится независимо от формул (см. тесты):
 *   последний cashFlow.cumulative === последний monthlyPnl.cumulativeProfit
 *                                     - upfrontInvestment
 * Деньги не появляются и не исчезают: сдвиги по времени переставляют платежи
 * между месяцами, но не меняют их сумму.
 */

export const ENGINE_VERSION = "0.2.0";

// ---------------------------------------------------------------------------
// Входы
// ---------------------------------------------------------------------------

export interface CommissionRate {
  category: string;
  /** Referral fee, доля от цены: 0.15 = 15% */
  rate: number;
  /** Фиксированная комиссия за единицу, в валюте расчёта */
  fixedFee: number;
}

export interface CalculatorInputs {
  /** Категория товара (ключ в справочнике комиссий) */
  category: string;
  /** Цена продажи за единицу */
  salePrice: number;
  /** Себестоимость единицы (закупка) */
  unitCost: number;
  /** Логистика до склада Amazon, на единицу */
  inboundShippingPerUnit: number;
  /** FBA fulfillment fee, на единицу */
  fbaFeePerUnit: number;
  /** Хранение, на единицу в месяц */
  storagePerUnitMonth: number;
  /** Реклама (ACoS), доля от выручки: 0.1 = 10% */
  acos: number;
  /** Прочие переменные расходы на единицу */
  otherVariablePerUnit: number;
  /** Постоянные расходы в месяц */
  fixedCostsPerMonth: number;
  /** План продаж по месяцам, штук */
  monthlyUnits: number[];
  /** Стартовые вложения (образцы, сертификация и т.п.) */
  upfrontInvestment: number;
  /** Отсрочка выплат Amazon, дней (для cash flow) */
  payoutDelayDays: number;
  /** Срок оборачиваемости закупки, дней (оплата товара до продажи) */
  leadTimeDays: number;
}

/**
 * Как задержки в днях ложатся на месячную сетку cash flow.
 *
 * "fractional" (по умолчанию) — платёж делится между двумя соседними месяцами
 *   пропорционально: отсрочка 14 дней ≈ 0.467 месяца, то есть 53.3% денег
 *   приходит в месяц продажи, 46.7% — в следующий. Предполагает равномерные
 *   продажи внутри месяца.
 * "wholeMonths" — исторический вариант: сдвиг округляется до целых месяцев
 *   (Math.round). ОСТОРОЖНО: 14 дней -> 0 месяцев, то есть отсрочка выплат
 *   Amazon полностью пропадает из расчёта и requiredCapital занижается.
 *
 * Режим — серверная константа, а не пользовательский вход: политика времени
 * это часть защищаемой модели. Если Excel-модель заказчика округляет до целых
 * месяцев, переключение делается здесь, в одной точке.
 */
export interface TimingPolicy {
  mode: "fractional" | "wholeMonths";
  /** Дней в условном месяце модели */
  daysPerMonth: number;
}

export const DEFAULT_TIMING: TimingPolicy = {
  mode: "fractional",
  daysPerMonth: 30,
};

// ---------------------------------------------------------------------------
// Выходы
// ---------------------------------------------------------------------------

export interface UnitEconomics {
  salePrice: number;
  referralFee: number;
  fbaFee: number;
  landedCost: number;
  adCostPerUnit: number;
  variableCostTotal: number;
  contributionMarginPerUnit: number;
  marginPct: number;
}

export interface MonthlyPnlRow {
  month: number;
  units: number;
  revenue: number;
  cogs: number;
  amazonFees: number;
  adSpend: number;
  storage: number;
  otherVariable: number;
  fixedCosts: number;
  netProfit: number;
  cumulativeProfit: number;
}

export interface CashFlowRow {
  month: number;
  inflow: number;
  outflow: number;
  net: number;
  cumulative: number;
}

export interface CalculatorResults {
  engineVersion: string;
  unitEconomics: UnitEconomics;
  monthlyPnl: MonthlyPnlRow[];
  cashFlow: CashFlowRow[];
  requiredCapital: number;
  paybackMonth: number | null; // null = не окупается на горизонте плана
}

// ---------------------------------------------------------------------------
// Расчёт
// ---------------------------------------------------------------------------

function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

export function calcUnitEconomics(
  i: CalculatorInputs,
  c: CommissionRate,
): UnitEconomics {
  const referralFee = i.salePrice * c.rate + c.fixedFee;
  const landedCost = i.unitCost + i.inboundShippingPerUnit;
  const adCostPerUnit = i.salePrice * i.acos;
  const variableCostTotal =
    landedCost +
    referralFee +
    i.fbaFeePerUnit +
    i.storagePerUnitMonth +
    adCostPerUnit +
    i.otherVariablePerUnit;
  const cm = i.salePrice - variableCostTotal;
  return {
    salePrice: round2(i.salePrice),
    referralFee: round2(referralFee),
    fbaFee: round2(i.fbaFeePerUnit),
    landedCost: round2(landedCost),
    adCostPerUnit: round2(adCostPerUnit),
    variableCostTotal: round2(variableCostTotal),
    contributionMarginPerUnit: round2(cm),
    marginPct: i.salePrice > 0 ? round2((cm / i.salePrice) * 100) : 0,
  };
}

/** Сдвиг в месяцах для задержки в днях, согласно политике времени. */
function shiftMonths(days: number, timing: TimingPolicy): number {
  const raw = days / timing.daysPerMonth;
  return timing.mode === "wholeMonths" ? Math.round(raw) : raw;
}

/**
 * Кладёт сумму в месячную корзину по дробному индексу, разнося её между двумя
 * соседними месяцами. Индексы вне горизонта прижимаются к границам:
 *   - платёж «до старта» (закупка под первые месяцы продаж) попадает в месяц 1,
 *     потому что раньше старта проекта денег потратить нельзя;
 *   - платёж за границей горизонта попадает в последний месяц.
 * Прижатие, а не отбрасывание, — то, что сохраняет сходимость cash flow и P&L.
 */
function place(buckets: number[], monthIdx: number, amount: number): void {
  if (amount === 0) return;
  const last = buckets.length - 1;
  const lo = Math.floor(monthIdx);
  const w = monthIdx - lo; // доля, уходящая в следующий месяц
  const put = (i: number, amt: number) => {
    if (amt === 0) return;
    buckets[Math.min(Math.max(i, 0), last)] += amt;
  };
  put(lo, amount * (1 - w));
  put(lo + 1, amount * w);
}

export function calculate(
  inputs: CalculatorInputs,
  commission: CommissionRate,
  timing: TimingPolicy = DEFAULT_TIMING,
): CalculatorResults {
  const ue = calcUnitEconomics(inputs, commission);

  // Неокруглённые ставки: округление до копеек делаем только на выходе.
  // Использование округлённого referralFee в агрегатах давало расхождение
  // до 0.005 * units за месяц против Excel.
  const referralFeeRaw = inputs.salePrice * commission.rate + commission.fixedFee;
  const landedCostRaw = inputs.unitCost + inputs.inboundShippingPerUnit;
  const amazonFeePerUnitRaw = referralFeeRaw + inputs.fbaFeePerUnit;

  const months = inputs.monthlyUnits.length;

  const monthlyPnl: MonthlyPnlRow[] = [];
  let cumulative = 0;
  inputs.monthlyUnits.forEach((units, idx) => {
    const revenue = units * inputs.salePrice;
    const cogs = units * landedCostRaw;
    const amazonFees = units * amazonFeePerUnitRaw;
    const adSpend = revenue * inputs.acos;
    const storage = units * inputs.storagePerUnitMonth;
    const otherVariable = units * inputs.otherVariablePerUnit;
    const netProfit =
      revenue - cogs - amazonFees - adSpend - storage - otherVariable -
      inputs.fixedCostsPerMonth;
    cumulative += netProfit;
    monthlyPnl.push({
      month: idx + 1,
      units,
      revenue: round2(revenue),
      cogs: round2(cogs),
      amazonFees: round2(amazonFees),
      adSpend: round2(adSpend),
      storage: round2(storage),
      otherVariable: round2(otherVariable),
      fixedCosts: round2(inputs.fixedCostsPerMonth),
      netProfit: round2(netProfit),
      cumulativeProfit: round2(cumulative),
    });
  });

  // --- Cash flow -----------------------------------------------------------
  // Выручка месяца k приходит через payoutDelay, комиссии Amazon удерживаются
  // из той же выплаты. Закупка под продажи месяца k оплачивается за leadTime ДО
  // продажи; если это «раньше нулевого месяца» — деньги нужны на старте
  // (месяц 1), а не исчезают из расчёта.
  const payoutShift = shiftMonths(inputs.payoutDelayDays, timing);
  const leadShift = shiftMonths(inputs.leadTimeDays, timing);
  const horizon = Math.max(1, months + Math.ceil(payoutShift));

  const inflows = new Array<number>(horizon).fill(0);
  const outflows = new Array<number>(horizon).fill(0);

  inputs.monthlyUnits.forEach((units, k) => {
    place(inflows, k + payoutShift, units * inputs.salePrice);
    place(outflows, k + payoutShift, units * amazonFeePerUnitRaw);
    place(outflows, k - leadShift, units * landedCostRaw);
    place(
      outflows,
      k,
      units * inputs.salePrice * inputs.acos +
        units * (inputs.storagePerUnitMonth + inputs.otherVariablePerUnit) +
        inputs.fixedCostsPerMonth,
    );
  });

  const cashFlow: CashFlowRow[] = [];
  let cfCumulative = -inputs.upfrontInvestment;
  let minCumulative = cfCumulative;
  for (let m = 0; m < horizon; m++) {
    const net = inflows[m] - outflows[m];
    cfCumulative += net;
    if (cfCumulative < minCumulative) minCumulative = cfCumulative;
    cashFlow.push({
      month: m + 1,
      inflow: round2(inflows[m]),
      outflow: round2(outflows[m]),
      net: round2(net),
      cumulative: round2(cfCumulative),
    });
  }

  const paybackRow = cashFlow.find((r) => r.cumulative >= 0);

  return {
    engineVersion: ENGINE_VERSION,
    unitEconomics: ue,
    monthlyPnl,
    cashFlow,
    requiredCapital: round2(-minCumulative > 0 ? -minCumulative : 0),
    paybackMonth: paybackRow ? paybackRow.month : null,
  };
}
