import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import {
  getThemePreference,
  setThemePreference,
  subscribeTheme,
  type ThemePreference,
} from "./theme";

const choices = [
  { value: "light", label: "浅色", Icon: Sun },
  { value: "dark", label: "深色", Icon: Moon },
  { value: "system", label: "跟随系统", Icon: Monitor },
] as const;

export function ThemeSwitch() {
  const preference = useSyncExternalStore(
    subscribeTheme,
    getThemePreference,
    () => "system" as ThemePreference,
  );

  return (
    <div className="theme-switch" role="group" aria-label="外观">
      {choices.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          aria-label={label}
          aria-pressed={preference === value}
          onClick={() => setThemePreference(value)}
        >
          <Icon size={15} aria-hidden="true" />
          <span className="theme-switch-label">{label}</span>
        </button>
      ))}
    </div>
  );
}
