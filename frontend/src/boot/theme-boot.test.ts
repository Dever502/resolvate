// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(new URL("./theme-boot.js", import.meta.url), "utf8");

function boot(stored: string | null, systemDark: boolean, storageThrows = false): string | undefined {
  const root = { dataset: {} as Record<string, string> };
  runInNewContext(SOURCE, {
    localStorage: {
      getItem: () => {
        if (storageThrows) throw new Error("denied");
        return stored;
      },
    },
    window: { matchMedia: () => ({ matches: systemDark }) },
    document: { documentElement: root },
  });
  return root.dataset.theme;
}

describe("theme boot script", () => {
  it.each([
    [null, false, "light"],
    [null, true, "dark"],
    ["light", true, "light"],
    ["dark", false, "dark"],
    ["unknown", true, "dark"],
  ] as const)("stored %s, system dark %s → %s", (stored, systemDark, expected) => {
    expect(boot(stored, systemDark)).toBe(expected);
  });

  it("falls back to the system theme when storage is unavailable", () => {
    expect(boot("dark", false, true)).toBe("light");
  });
});
