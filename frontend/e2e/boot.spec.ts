import { PASSWORD, SESSION_COOKIE, expect, probe, scenario, stubLog, test } from "./fixtures";

const CONSOLE = "/console/next/";
const preferDark = (): void => localStorage.setItem("resolvate.theme", "dark");

test.describe("start of the console", () => {
  test("a reload with a live session never shows the sign-in form or a light frame", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await scenario(request, { me: "session", meDelay: 400 });
    await context.addCookies([SESSION_COOKIE]);
    await page.addInitScript(preferDark);
    for (const load of [() => page.goto(CONSOLE), () => page.reload()]) {
      await load();
      await expect(page.locator("#workspace")).toBeVisible();
      const recorded = await probe(page);
      expect(recorded.loginSeen).toBe(false);
      expect(recorded.themes.length).toBeGreaterThan(0);
      expect(new Set(recorded.themes)).toEqual(new Set(["dark"]));
    }
  });

  test("without a session the form appears in the saved theme with the login field focused", async ({ page, request, consoleErrors }) => {
    void consoleErrors;
    await scenario(request, { me: "session" });
    await page.addInitScript(preferDark);
    await page.goto(CONSOLE);
    await expect(page.locator("#login-screen")).toBeVisible();
    await expect(page.locator('input[name="login"]')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    await expect(page.locator("#login-screen")).toHaveCSS("background-color", "rgb(23, 25, 29)");
    expect((await probe(page)).themes.every((theme) => theme === "dark")).toBe(true);
  });

  test("the sign-in form fits a 320 px screen without horizontal scrolling", async ({ page, request, consoleErrors }) => {
    void consoleErrors;
    await scenario(request, { me: "session" });
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(CONSOLE);
    await expect(page.locator("#login-form")).toBeVisible();
    const layout = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      form: document.getElementById("login-form")!.getBoundingClientRect().toJSON() as DOMRect,
    }));
    expect(layout.scroll).toBeLessThanOrEqual(320);
    expect(layout.form.left).toBeGreaterThanOrEqual(0);
    expect(layout.form.right).toBeLessThanOrEqual(320);
  });

  test("sign in, cycle the theme, sign out", async ({ page, request, consoleErrors }) => {
    void consoleErrors;
    await scenario(request, { me: "session" });
    await page.goto(CONSOLE);
    await page.locator('input[name="login"]').fill("operator");
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByRole("button", { name: "Войти" }).click();
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(page.getByText("Оператор Тест")).toBeVisible();

    const toggle = page.locator("[data-theme-toggle]");
    const states = [
      ["system", "Системная тема · переключить на светлую", null],
      ["light", "Светлая тема · переключить на тёмную", "light"],
      ["dark", "Тёмная тема · переключить на системную", "dark"],
      ["system", "Системная тема · переключить на светлую", null],
    ] as const;
    for (const [index, [preference, label, stored]] of states.entries()) {
      if (index) await toggle.click();
      await expect(toggle).toHaveAttribute("data-theme-preference", preference);
      await expect(toggle).toHaveAttribute("aria-label", label);
      await expect(toggle).toHaveAttribute("title", label);
      expect(await page.evaluate(() => localStorage.getItem("resolvate.theme"))).toBe(stored);
      if (stored) expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(stored);
    }

    await page.getByRole("button", { name: "Выйти" }).click();
    await expect(page.locator("#login-screen")).toBeVisible();
  });

  for (const [name, failure, reason] of [
    ["502 from the proxy", 502, "Запрос не выполнен. Повторите позже."],
    ["429 from the rate limit", { status: 429, detail: "Слишком много запросов." }, "Слишком много запросов."],
  ] as const) {
    test(`after ${name} the check is retried and the workspace opens`, async ({ page, context, request, consoleErrors }) => {
      void consoleErrors;
      await scenario(request, { me: [failure, "session"] });
      await context.addCookies([SESSION_COOKIE]);
      await page.goto(CONSOLE);
      await expect(page.locator("#login-error")).toHaveText(`${reason} Повторяем проверку входа…`);
      await expect(page.locator("#workspace")).toBeVisible({ timeout: 6000 });
    });
  }

  test("after a dropped connection the check is retried and the workspace opens", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await scenario(request, { me: "session" });
    await context.addCookies([SESSION_COOKIE]);
    // Browsers silently repeat a GET after a reset, so the failure is injected at the network layer.
    let dropped = false;
    await page.route("**/console/me", async (route) => {
      if (dropped) return route.continue();
      dropped = true;
      await route.abort("connectionreset");
    });
    await page.goto(CONSOLE);
    await expect(page.locator("#login-error")).toHaveText("Нет связи с сервером. Повторяем проверку входа…");
    await expect(page.locator("#workspace")).toBeVisible({ timeout: 6000 });
  });

  for (const [name, stalled] of [
    ["no answer", { status: "stall" }],
    ["an answer whose body stalls", { status: "session", stall: "body" }],
  ] as const) {
    test(`after ${name} the check is aborted, retried and the workspace opens`, async ({ page, context, request, consoleErrors }) => {
      void consoleErrors;
      await scenario(request, { me: [stalled, "session"] });
      await context.addCookies([SESSION_COOKIE]);
      await page.clock.install();
      await page.goto(CONSOLE);
      // Mounted: the check and its deadline are running, and nothing is shown yet.
      await expect(page.locator("#app[data-v-app]")).toBeAttached();
      await expect(page.locator("#login-screen, #workspace")).toHaveCount(0);
      await page.clock.fastForward(10_000); // CHECK_TIMEOUT in src/stores/session.ts
      await expect(page.locator("#login-error")).toHaveText("Нет связи с сервером. Повторяем проверку входа…");
      await expect.poll(async () => (await stubLog(request)).find((entry) => entry.path === "/console/me")?.aborted)
        .toBe(true);
      await page.clock.fastForward(3_000); // RETRY_DELAYS[0]
      await expect(page.locator("#workspace")).toBeVisible();
    });
  }

  test("signing in while a check is pending is not undone by its late 401", async ({ page, request, consoleErrors }) => {
    void consoleErrors;
    await scenario(request, { me: [502, { status: "session", delay: 2500 }] });
    await page.goto(CONSOLE);
    await expect(page.locator("#login-error")).toContainText("Повторяем проверку входа…");
    // Wait until the retry is in flight, then sign in before it answers 401.
    await expect.poll(async () => (await stubLog(request)).filter((entry) => entry.path === "/console/me").length,
      { timeout: 6000 }).toBe(2);
    await page.locator('input[name="login"]').fill("operator");
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByRole("button", { name: "Войти" }).click();
    await expect(page.locator("#workspace")).toBeVisible();
    await page.waitForTimeout(3000);
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(page.locator("#login-screen")).toHaveCount(0);
  });
});

test.describe("workspace frame", () => {
  for (const [device, viewport] of [
    ["a phone", { width: 375, height: 812 }],
    ["a desktop", { width: 1280, height: 800 }],
  ] as const) {
    test(`a failed sign-out shows its reason on ${device}`, async ({ page, context, request, consoleErrors }) => {
      void consoleErrors;
      await scenario(request, { me: "session", logout: 502 });
      await context.addCookies([SESSION_COOKIE]);
      await page.setViewportSize(viewport);
      await page.goto(CONSOLE);
      await page.getByRole("button", { name: "Выйти" }).click();
      // Exactly one notice is visible: in the conversation panel, or above the list where that panel is hidden.
      const alert = page.getByRole("alert");
      await expect(alert).toHaveText("Запрос не выполнен. Повторите позже.");
      await expect(alert).toBeInViewport();
      await expect(page.locator("#workspace")).toBeVisible();
    });
  }
});

test.describe("delivery of the console", () => {
  test("the session check starts before the application code has loaded", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await scenario(request, { me: "session", appDelay: 600 });
    await context.addCookies([SESSION_COOKIE]);
    await page.goto(CONSOLE);
    await expect(page.locator("#workspace")).toBeVisible();
    const timing = await page.evaluate(() => {
      const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      const me = entries.find((entry) => entry.name.endsWith("/console/me"));
      const app = entries.find((entry) => /\/assets\/app-[\w-]+\.js$/.test(entry.name));
      return { meStart: me?.startTime ?? -1, appEnd: app?.responseEnd ?? -1 };
    });
    expect(timing.meStart).toBeGreaterThanOrEqual(0);
    expect(timing.meStart).toBeLessThan(timing.appEnd);
  });

  test("assets arrive precompressed and come from the cache on the next visit", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await scenario(request, { me: "session" });
    await context.addCookies([SESSION_COOKIE]);
    const encodings: [string, string][] = [];
    page.on("response", async (response) => {
      if (!/\/assets\/app-[\w-]+\.js$/.test(response.url())) return;
      const accepted = (await response.request().allHeaders())["accept-encoding"] ?? "";
      encodings.push([accepted, response.headers()["content-encoding"] ?? ""]);
    });
    await page.goto(CONSOLE);
    await expect(page.locator("#workspace")).toBeVisible();
    // Brotli when the engine asks for it (Chromium, Firefox), otherwise gzip (WebKit on Linux).
    await expect.poll(() => encodings.length).toBe(1);
    const [accepted, encoding] = encodings[0]!;
    expect(encoding).toBe(/\bbr\b/.test(accepted) ? "br" : "gzip");
    const assets = async (): Promise<number> =>
      (await stubLog(request)).filter((entry) => entry.path.startsWith("/console/next/assets/")).length;
    const first = await assets();
    expect(first).toBeGreaterThanOrEqual(4);
    await page.goto("about:blank");
    await page.goto(CONSOLE);
    await expect(page.locator("#workspace")).toBeVisible();
    expect(await assets()).toBe(first);
  });

  test("the address without a trailing slash keeps the deep link", async ({ page, request, consoleErrors }) => {
    void consoleErrors;
    await scenario(request, { me: "session" });
    await page.goto("/console/next?project=p1&ticket=t1");
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe("/console/next/?project=p1&ticket=t1");
    await expect(page.locator("#login-screen")).toBeVisible();
  });
});
