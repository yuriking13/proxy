/**
 * Валидация входов без внешних зависимостей — один и тот же код
 * работает в Deno (Edge Function) и Node (тесты).
 * Возвращает нормализованные inputs или список ошибок.
 *
 * Результат — новый объект строго с известными полями (whitelist): именно он
 * уходит в engine и пишется в calculations.inputs, поэтому лишние ключи из
 * тела запроса до базы не доходят.
 */
import type { CalculatorInputs } from "./index.ts";

export interface ValidationError {
  field: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; value: CalculatorInputs }
  | { ok: false; errors: ValidationError[] };

const MAX_MONTHS = 60;
const MAX_MONEY = 1e9;
const MAX_UNITS = 1e7;
/** ACoS выше 100% — нормальная ситуация на этапе запуска, поэтому не 1. */
const MAX_ACOS = 5;

interface NumOpts {
  min?: number;
  max?: number;
  /** Требовать целое значение (штуки товара) */
  integer?: boolean;
}

function num(
  v: unknown,
  field: string,
  errors: ValidationError[],
  { min = 0, max = MAX_MONEY, integer = false }: NumOpts = {},
): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    errors.push({ field, message: "must be a finite number" });
    return 0;
  }
  if (v < min || v > max) {
    errors.push({ field, message: `must be between ${min} and ${max}` });
    return 0;
  }
  if (integer && !Number.isInteger(v)) {
    errors.push({ field, message: "must be an integer" });
    return 0;
  }
  return v;
}

export function validateInputs(raw: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [{ field: "", message: "inputs must be an object" }],
    };
  }
  const r = raw as Record<string, unknown>;

  let category = "";
  if (
    typeof r.category === "string" && r.category.length > 0 &&
    r.category.length <= 100
  ) {
    category = r.category;
  } else {
    errors.push({ field: "category", message: "required string (1..100)" });
  }

  const monthlyUnitsRaw = r.monthlyUnits;
  let monthlyUnits: number[] = [];
  if (
    !Array.isArray(monthlyUnitsRaw) || monthlyUnitsRaw.length === 0 ||
    monthlyUnitsRaw.length > MAX_MONTHS
  ) {
    errors.push({
      field: "monthlyUnits",
      message: `must be an array of 1..${MAX_MONTHS} numbers`,
    });
  } else {
    monthlyUnits = monthlyUnitsRaw.map((u, i) =>
      num(u, `monthlyUnits[${i}]`, errors, {
        min: 0,
        max: MAX_UNITS,
        integer: true,
      })
    );
  }

  const value: CalculatorInputs = {
    category,
    salePrice: num(r.salePrice, "salePrice", errors, { min: 0.01 }),
    unitCost: num(r.unitCost, "unitCost", errors),
    inboundShippingPerUnit: num(
      r.inboundShippingPerUnit,
      "inboundShippingPerUnit",
      errors,
    ),
    fbaFeePerUnit: num(r.fbaFeePerUnit, "fbaFeePerUnit", errors),
    storagePerUnitMonth: num(r.storagePerUnitMonth, "storagePerUnitMonth", errors),
    acos: num(r.acos, "acos", errors, { min: 0, max: MAX_ACOS }),
    otherVariablePerUnit: num(
      r.otherVariablePerUnit,
      "otherVariablePerUnit",
      errors,
    ),
    fixedCostsPerMonth: num(r.fixedCostsPerMonth, "fixedCostsPerMonth", errors),
    monthlyUnits,
    upfrontInvestment: num(r.upfrontInvestment, "upfrontInvestment", errors),
    payoutDelayDays: num(r.payoutDelayDays, "payoutDelayDays", errors, {
      min: 0,
      max: 120,
    }),
    leadTimeDays: num(r.leadTimeDays, "leadTimeDays", errors, {
      min: 0,
      max: 365,
    }),
  };

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}
