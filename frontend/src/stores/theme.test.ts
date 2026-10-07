import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { THEME_KEY, THEME_LABELS, normalizeTheme, useThemeStore } from "./theme";

describe("theme store", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("cycles system → light → dark → system and stores it like the classic console", () => {
    const theme = useThemeStore();
    expect(theme.preference).toBe("system");
    theme.cycle();
    expect([theme.preference, localStorage.getItem(THEME_KEY)]).toEqual(["light", "light"]);
    theme.cycle();
    expect([theme.preference, localStorage.getItem(THEME_KEY)]).toEqual(["dark", "dark"]);
    theme.cycle();
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

  it("labels name the current theme and the next action", () => {
    expect(THEME_LABELS).toEqual({
      system: "Системная тема · переключить на светлую",
      light: "Светлая тема · переключить на тёмную",
      dark: "Тёмная тема · переключить на системную",
    });
  });
});
