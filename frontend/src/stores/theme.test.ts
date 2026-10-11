import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { THEME_KEY, THEME_LABELS, normalizeTheme, useThemeStore } from "./theme";

describe("theme store", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("selects themes directly and stores them like the classic console", () => {
    const theme = useThemeStore();
    expect(theme.preference).toBe("system");
    theme.setPreference("dark");
    expect([theme.preference, localStorage.getItem(THEME_KEY)]).toEqual(["dark", "dark"]);
    theme.setPreference("light");
    expect([theme.preference, localStorage.getItem(THEME_KEY)]).toEqual(["light", "light"]);
    theme.setPreference("light");
    expect([theme.preference, localStorage.getItem(THEME_KEY)]).toEqual(["light", "light"]);
    theme.setPreference("system");
    expect([theme.preference, localStorage.getItem(THEME_KEY)]).toEqual(["system", null]);
  });

  it("reads the saved choice and resolves the system theme", () => {
    localStorage.setItem(THEME_KEY, "dark");
    expect(useThemeStore().resolved).toBe("dark");
    setActivePinia(createPinia());
    localStorage.removeItem(THEME_KEY);
    const theme = useThemeStore();
    expect(theme.resolved).toBe("light");
    theme.systemDark = true;
    expect(theme.resolved).toBe("dark");
  });

  it("treats unknown stored values as the system theme", () => {
    expect(normalizeTheme("blue")).toBe("system");
    expect(normalizeTheme(null)).toBe("system");
  });

  it("labels name the direct choices", () => {
    expect(THEME_LABELS).toEqual({
      system: "Системная тема",
      light: "Светлая тема",
      dark: "Тёмная тема",
    });
  });
});
