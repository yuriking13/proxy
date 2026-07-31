/**
 * Golden-тесты: при переносе реального проекта эталоны берутся из Excel-модели
 * заказчика (входы -> ожидаемые выходы, посчитанные в Excel).
 * Ниже — тесты каркаса: инварианты + сквозные сценарии.
 * Запуск: node --experimental-strip-types --test engine/tests/engine.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { calcUnitEconomics, calculate } from "../src/index.ts";
import { validateInputs } from "../src/validate.ts";
import type {
  CalculatorInputs,
  CommissionRate,
  TimingPolicy,
} from "../src/index.ts";

const commission: CommissionRate = { category: "home", rate: 0.15, fixedFee: 0 };

const baseInputs: CalculatorInputs = {
  category: "home",
  salePrice: 25,
  unitCost: 6,
  inboundShippingPerUnit: 1.5,
  fbaFeePerUnit: 4.5,
  storagePerUnitMonth: 0.4,
  acos: 0.1,
  otherVariablePerUnit: 0.5,
  fixedCostsPerMonth: 500,
  monthlyUnits: [200, 300, 400, 500, 600, 700],
  upfrontInvestment: 2000,
  payoutDelayDays: 14,
  leadTimeDays: 45,
};

const WHOLE_MONTHS: TimingPolicy = { mode: "wholeMonths", daysPerMonth: 30 };

test("unit economics: referral fee and margin", () => {
  const ue = calcUnitEconomics(baseInputs, commission);
  assert.equal(ue.referralFee, 3.75); // 25 * 0.15
  assert.equal(ue.landedCost, 7.5); // 6 + 1.5
  assert.equal(ue.adCostPerUnit, 2.5); // 25 * 0.1
  // 25 - (7.5 + 3.75 + 4.5 + 0.4 + 2.5 + 0.5) = 5.85
  assert.equal(ue.contributionMarginPerUnit, 5.85);
  assert.equal(ue.marginPct, 23.4);
});

test("monthly P&L: month 1 net profit and cumulative chain", () => {
  const r = calculate(baseInputs, commission);
  const m1 = r.monthlyPnl[0];
  // revenue 5000; cogs 1500; fees 200*(3.75+4.5)=1650; ads 500;
  // storage 80; other 100; fixed 500 => 5000-1500-1650-500-80-100-500 = 670
  assert.equal(m1.revenue, 5000);
  assert.equal(m1.netProfit, 670);
  // cumulative монотонно согласован
  let cum = 0;
  for (const row of r.monthlyPnl) {
    cum = Math.round((cum + row.netProfit) * 100) / 100;
    assert.equal(row.cumulativeProfit, cum);
  }
});

test("cash flow: cumulative starts below zero, requiredCapital positive", () => {
  const r = calculate(baseInputs, commission);
  assert.ok(r.cashFlow[0].cumulative < 0);
  assert.ok(r.requiredCapital > 0);
  // требуемый капитал = максимальная просадка кумулятива (включая upfront)
  const minCum = Math.min(
    -baseInputs.upfrontInvestment,
    ...r.cashFlow.map((x) => x.cumulative),
  );
  assert.equal(r.requiredCapital, Math.round(-minCum * 100) / 100);
});

test("payback month is where cumulative crosses zero", () => {
  const r = calculate(baseInputs, commission);
  if (r.paybackMonth !== null) {
    const row = r.cashFlow[r.paybackMonth - 1];
    assert.ok(row.cumulative >= 0);
    if (r.paybackMonth > 1) {
      assert.ok(r.cashFlow[r.paybackMonth - 2].cumulative < 0);
    }
  } else {
    assert.ok(r.cashFlow.every((x) => x.cumulative < 0));
  }
});

test("unprofitable scenario never pays back", () => {
  const bad: CalculatorInputs = { ...baseInputs, salePrice: 10 };
  const r = calculate(bad, commission);
  assert.equal(r.paybackMonth, null);
});

// ---------------------------------------------------------------------------
// Инварианты сходимости cash flow и P&L.
// Регрессия на баг: закупка под продажи первых leadTime-месяцев приходилась на
// «отрицательные» месяцы и просто выпадала из cash flow — COGS исчезал,
// requiredCapital занижался. Проверяем на обеих политиках времени и на наборе
// сценариев, чтобы поймать любое повторное расхождение.
// ---------------------------------------------------------------------------

const SCENARIOS: Array<[string, CalculatorInputs]> = [
  ["base", baseInputs],
  ["no delays", { ...baseInputs, payoutDelayDays: 0, leadTimeDays: 0 }],
  ["long lead time", { ...baseInputs, leadTimeDays: 180 }],
  ["long payout delay", { ...baseInputs, payoutDelayDays: 120 }],
  ["single month", { ...baseInputs, monthlyUnits: [100] }],
  ["zero months of sales", { ...baseInputs, monthlyUnits: [0, 0, 0] }],
  ["loss making", { ...baseInputs, salePrice: 10 }],
  ["no upfront", { ...baseInputs, upfrontInvestment: 0 }],
];

for (const [name, inputs] of SCENARIOS) {
  for (const timing of [undefined, WHOLE_MONTHS]) {
    const mode = timing ? timing.mode : "fractional";

    test(`cash flow reconciles with P&L: ${name} (${mode})`, () => {
      const r = calculate(inputs, commission, timing);
      const pnlTotal = r.monthlyPnl.at(-1)!.cumulativeProfit;
      const cfFinal = r.cashFlow.at(-1)!.cumulative;
      // Сдвиги во времени переставляют платежи, но не создают и не уничтожают
      // деньги: к концу горизонта касса = накопленная прибыль минус стартовые
      // вложения.
      assert.ok(
        Math.abs(cfFinal - (pnlTotal - inputs.upfrontInvestment)) < 0.05,
        `cash ${cfFinal} != pnl ${pnlTotal} - upfront ${inputs.upfrontInvestment}`,
      );
    });

    test(`cash flow charges COGS in full: ${name} (${mode})`, () => {
      const r = calculate(inputs, commission, timing);
      const totalOut = r.cashFlow.reduce((a, x) => a + x.outflow, 0);
      const totalCogs = r.monthlyPnl.reduce((a, x) => a + x.cogs, 0);
      // Закупка целиком присутствует в оттоках, даже если по срокам она
      // приходится на время до старта проекта.
      assert.ok(
        totalOut >= totalCogs - 0.05,
        `outflows ${totalOut} < cogs ${totalCogs}`,
      );
    });
  }
}

test("14-дневная отсрочка выплат влияет на требуемый капитал", () => {
  const noDelay = calculate({ ...baseInputs, payoutDelayDays: 0 }, commission);
  const withDelay = calculate(baseInputs, commission); // 14 дней
  // Дробная политика видит 14 дней; Math.round(14/30) = 0 их терял.
  assert.ok(
    withDelay.requiredCapital > noDelay.requiredCapital,
    `${withDelay.requiredCapital} should exceed ${noDelay.requiredCapital}`,
  );
  // Документируем поведение исторического режима: отсрочка < 15 дней теряется.
  const rounded = calculate(baseInputs, commission, WHOLE_MONTHS);
  const roundedNoDelay = calculate(
    { ...baseInputs, payoutDelayDays: 0 },
    commission,
    WHOLE_MONTHS,
  );
  assert.equal(rounded.requiredCapital, roundedNoDelay.requiredCapital);
});

test("более длинный lead time не уменьшает требуемый капитал", () => {
  const short = calculate({ ...baseInputs, leadTimeDays: 0 }, commission);
  const long = calculate({ ...baseInputs, leadTimeDays: 120 }, commission);
  assert.ok(long.requiredCapital >= short.requiredCapital);
});

test("агрегаты не используют округлённые ставки", () => {
  // rate = 1/3 даёт referral fee 8.3333...; округление до 8.33 на единицу дало
  // бы расхождение 0.0033 * 1000 = 3.33 за месяц.
  const odd: CommissionRate = { category: "home", rate: 1 / 3, fixedFee: 0 };
  const inputs: CalculatorInputs = { ...baseInputs, monthlyUnits: [1000] };
  const r = calculate(inputs, odd, WHOLE_MONTHS);
  const expectedFees = 1000 * (25 / 3 + inputs.fbaFeePerUnit);
  assert.ok(
    Math.abs(r.monthlyPnl[0].amazonFees - expectedFees) < 0.01,
    `${r.monthlyPnl[0].amazonFees} != ${expectedFees}`,
  );
});

test("validation: rejects garbage, accepts base inputs", () => {
  assert.equal(validateInputs(baseInputs).ok, true);
  assert.equal(validateInputs(null).ok, false);
  assert.equal(validateInputs({ ...baseInputs, salePrice: -5 }).ok, false);
  assert.equal(validateInputs({ ...baseInputs, acos: 9 }).ok, false);
  assert.equal(validateInputs({ ...baseInputs, monthlyUnits: [] }).ok, false);
  assert.equal(
    validateInputs({ ...baseInputs, monthlyUnits: Array(100).fill(1) }).ok,
    false,
  );
  assert.equal(validateInputs({ ...baseInputs, salePrice: NaN }).ok, false);
  assert.equal(validateInputs({ ...baseInputs, salePrice: Infinity }).ok, false);
});

test("validation: ACoS выше 100% допустим (фаза запуска)", () => {
  assert.equal(validateInputs({ ...baseInputs, acos: 1.5 }).ok, true);
});

test("validation: дробные и отрицательные единицы отклоняются", () => {
  assert.equal(validateInputs({ ...baseInputs, monthlyUnits: [1.5] }).ok, false);
  assert.equal(validateInputs({ ...baseInputs, monthlyUnits: [-1] }).ok, false);
});

test("validation: возвращает чистый объект без прототипного мусора", () => {
  const payload = JSON.parse(
    `{"__proto__":{"polluted":true},"category":"home","salePrice":25,"unitCost":6,
      "inboundShippingPerUnit":1.5,"fbaFeePerUnit":4.5,"storagePerUnitMonth":0.4,
      "acos":0.1,"otherVariablePerUnit":0.5,"fixedCostsPerMonth":500,
      "monthlyUnits":[10],"upfrontInvestment":0,"payoutDelayDays":14,
      "leadTimeDays":45}`,
  );
  const res = validateInputs(payload);
  assert.equal(res.ok, true);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  if (res.ok) {
    // В calculations пишется только whitelisted-набор полей.
    assert.equal(Object.hasOwn(res.value, "polluted"), false);
    assert.deepEqual(
      Object.keys(res.value).sort(),
      [
        "acos",
        "category",
        "fbaFeePerUnit",
        "fixedCostsPerMonth",
        "inboundShippingPerUnit",
        "leadTimeDays",
        "monthlyUnits",
        "otherVariablePerUnit",
        "payoutDelayDays",
        "salePrice",
        "storagePerUnitMonth",
        "unitCost",
        "upfrontInvestment",
      ],
    );
  }
});
