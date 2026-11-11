export interface NumberRules {
  min?: number;
  max?: number;
  integer?: boolean;
  decimalPlaces?: number;
}

/** A blank value is never coerced to zero. Call only for required values. */
export function parseNumberInput(
  value: string,
  label: string,
  { min = 0, max, integer = false, decimalPlaces }: NumberRules = {},
) {
  const text = value.trim();
  if (!text) throw new Error(`请填写${label}。`);
  if (!/^[0-9]+(?:[.][0-9]+)?$/.test(text))
    throw new Error(`${label}需要填写有效数字。`);
  const number = Number(text);
  if (!Number.isFinite(number) || number < min || (max != null && number > max))
    throw new Error(`${label}超出可填写范围。`);
  if (integer && !Number.isInteger(number))
    throw new Error(`${label}需要填写整数。`);
  if (decimalPlaces != null && (text.split(".")[1]?.length || 0) > decimalPlaces)
    throw new Error(`${label}最多保留 ${decimalPlaces} 位小数。`);
  return number;
}
