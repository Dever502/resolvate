import { defineStore } from "pinia";
import { computed, ref } from "vue";

export type ThemePreference = "system" | "light" | "dark";

/** Same key and values as the classic console: "light", "dark", or no value for the system theme. */
export const THEME_KEY = "resolvate.theme";

/** Accessible names of the three direct theme choices. */
export const THEME_LABELS: Record<ThemePreference, string> = {
  system: "Системная тема",
  light: "Светлая тема",
  dark: "Тёмная тема",
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

  function setPreference(value: ThemePreference): void {
    preference.value = value;
    writePreference(preference.value);
  }

  /** A choice made in another tab of this browser. */
  function adopt(value: string | null): void {
    preference.value = normalizeTheme(value);
  }

  return { preference, systemDark, resolved, setPreference, adopt };
});
