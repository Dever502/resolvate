import { defineStore } from "pinia";
import { computed, ref } from "vue";

export type ThemePreference = "system" | "light" | "dark";

/** Same key and values as the classic console: "light", "dark", or no value for the system theme. */
export const THEME_KEY = "resolvate.theme";

const NEXT: Record<ThemePreference, ThemePreference> = { system: "light", light: "dark", dark: "system" };

/** The button names the current theme and what a click does. */
export const THEME_LABELS: Record<ThemePreference, string> = {
  system: "Системная тема · переключить на светлую",
  light: "Светлая тема · переключить на тёмную",
  dark: "Тёмная тема · переключить на системную",
};

export function normalizeTheme(value: string | null): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

function readPreference(): ThemePreference {
  try {
    return normalizeTheme(localStorage.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

function writePreference(value: ThemePreference): void {
  try {
    if (value === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, value);
  } catch {
    // Without storage the choice lasts until the page is reloaded.
  }
}

export const useThemeStore = defineStore("theme", () => {
  const preference = ref<ThemePreference>(readPreference());
  const systemDark = ref(false);
  const resolved = computed<"light" | "dark">(() =>
    preference.value === "system" ? (systemDark.value ? "dark" : "light") : preference.value,
  );

  function cycle(): void {
    preference.value = NEXT[preference.value];
    writePreference(preference.value);
  }

  /** A choice made in another tab of this browser. */
  function adopt(value: string | null): void {
    preference.value = normalizeTheme(value);
  }

  return { preference, systemDark, resolved, cycle, adopt };
});
