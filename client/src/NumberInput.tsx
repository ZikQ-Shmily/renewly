import type { InputHTMLAttributes } from "react";

import type { NumberRules } from "./number";
export { parseNumberInput } from "./number";

type NumberInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "inputMode" | "min" | "max" | "step" | "pattern"
> & Pick<NumberRules, "integer" | "decimalPlaces">;

/** Text entry avoids browser spinner controls and accidental wheel changes. */
export function NumberInput({
  integer = false,
  decimalPlaces,
  ...props
}: NumberInputProps) {
  const pattern = integer
    ? "[0-9]+"
    : decimalPlaces == null
      ? "[0-9]+([.][0-9]+)?"
      : `[0-9]+([.][0-9]{1,${decimalPlaces}})?`;
  return (
    <input
      {...props}
      type="text"
      inputMode={integer ? "numeric" : "decimal"}
      pattern={pattern}
    />
  );
}

