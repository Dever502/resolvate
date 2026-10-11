import { SESSION_COOKIE, expect, probe, scenario, stubLog, test } from "./fixtures";

test.beforeEach(async ({ context, request, consoleErrors }) => {
  void consoleErrors;
  await scenario(request, { me: "session" });
  await context.addCookies([SESSION_COOKIE]);
});

test("one account trigger, informational identity, keyboard navigation and outside dismissal", async ({ page }) => {
  await page.goto("/console/");
  const trigger = page.getByRole("button", { name: "Меню аккаунта: Оператор Тест, Оператор" });
  await expect(page.locator("footer button")).toHaveCount(1);
  await expect(page.getByRole("menu")).toHaveCount(0);
  for (const key of ["Enter", "Space"]) {
    await trigger.press(key);
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(page.locator(".account-identity")).toContainText("Оператор Тест");
    await expect(page.locator(".account-identity button, .account-identity a, .account-identity [tabindex]")).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Настройки" })).toHaveCount(0);
    const system = page.getByRole("menuitemradio", { name: "Системная тема" });
    const light = page.getByRole("menuitemradio", { name: "Светлая тема" });
    const dark = page.getByRole("menuitemradio", { name: "Тёмная тема" });
    await expect(system).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(light).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(dark).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dark).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(light).toBeFocused();
    await page.keyboard.press("Space");
    await expect(light).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("ArrowDown");
    await expect(dark).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Выйти" })).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(dark).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
  // The name, not just the avatar/chevron, opens the menu.
  await trigger.getByText("Оператор Тест").click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("heading", { name: "Диалоги" }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("direct themes survive reload without a flash, follow system changes and other tabs", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/console/");
  const trigger = page.getByRole("button", { name: /Меню аккаунта:/ });
  for (const [label, value] of [["Тёмная тема", "dark"], ["Светлая тема", "light"]] as const) {
    await trigger.click();
    const option = page.getByRole("menuitemradio", { name: label });
    await option.click();
    await expect(option).toHaveAttribute("aria-checked", "true");
    await expect(page.locator('[role="menuitemradio"][aria-checked="true"]')).toHaveCount(1);
    await expect(page.getByRole("menu")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("resolvate.theme"))).toBe(value);
    await page.reload();
    await expect(trigger).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", value);
    expect((await probe(page)).themes.every(theme => theme === value)).toBe(true);
  }
  await trigger.click();
  await page.getByRole("menuitemradio", { name: "Системная тема" }).click();
  expect(await page.evaluate(() => localStorage.getItem("resolvate.theme"))).toBeNull();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "resolvate.theme", newValue: "dark" })));
  await expect(page.getByRole("menuitemradio", { name: "Тёмная тема" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("logout is single-flight, keeps a visible error after dismissal and clears session on retry", async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/console/");
  const trigger = page.getByRole("button", { name: /Меню аккаунта:/ });
  await trigger.click();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  await page.route("**/console/logout", async route => {
    calls++;
    await pending;
    await route.fulfill({ status: 502, contentType: "text/html", body: "Unavailable" });
  });
  const logout = page.locator(".account-logout");
  await logout.click();
  await expect(logout).toHaveAttribute("aria-disabled", "true");
  await logout.press("Enter");
  await logout.press("Space");
  release();
  await expect(page.getByRole("alert")).toHaveText("Запрос не выполнен. Повторите позже.");
  expect(calls).toBe(1);
  await expect(page.getByRole("alert")).toBeInViewport();
  await expect(page.locator("#workspace")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("alert")).toHaveCount(1);
  await expect(page.getByRole("alert")).toBeInViewport();
  await page.unroute("**/console/logout");
  await trigger.click();
  await expect(page.getByRole("alert")).toBeInViewport();
  await page.getByRole("menuitem", { name: "Выйти" }).click();
  await expect(page.locator("#login-screen")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Логин" })).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect((await stubLog(request)).filter(entry => entry.path === "/console/logout")).toHaveLength(1);
});

test("a late logout error remains visible when the menu was already closed", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/console/");
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/console/logout", async route => {
    await pending;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "Попробуйте позже." }) });
  });
  await page.getByRole("button", { name: /Меню аккаунта:/ }).click();
  await page.getByRole("menuitem", { name: "Выйти" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  release();
  await expect(page.getByRole("alert")).toHaveText("Попробуйте позже.");
  await expect(page.getByRole("alert")).toBeInViewport();
  await expect(page.locator("#workspace")).toBeVisible();
});

test("installation admin identity with a long name fits a narrow screen", async ({ page }) => {
  const name = "Администратор с очень длинным именем ".repeat(3).trim();
  await page.route("**/console/me", async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, account: { ...body.account, name, role: "admin" } } });
  });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/console/");
  const trigger = page.getByRole("button", { name: /Меню аккаунта:/ });
  await expect(trigger).toHaveAccessibleName(`Меню аккаунта: ${name}, Администратор установки`);
  await trigger.click();
  await expect(page.locator(".account-identity")).toContainText("Администратор установки");
  await expect(page.getByRole("menuitem", { name: "Выйти" })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

for (const width of [320, 375, 1280]) {
  for (const mode of ["light", "dark"] as const) {
    test(`menu bounds and ${mode} screenshot at ${width}px`, async ({ page, context }, testInfo) => {
      await page.setViewportSize({ width, height: 800 });
      await context.addInitScript(mode => localStorage.setItem("resolvate.theme", mode), mode);
      await page.goto("/console/");
      await page.getByRole("button", { name: /Меню аккаунта:/ }).click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      await expect(menu).toHaveAttribute("data-side", "top");
      const bounds = await menu.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(800);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await testInfo.attach(`account-${mode}-${width}.png`, { body: await page.screenshot(), contentType: "image/png" });
    });
  }
}

test.describe("touch account menu", () => {
  test.use({ hasTouch: true, viewport: { width: 375, height: 812 } });
  test("opens the full row and theme selection keeps the menu open", async ({ page }) => {
    await page.goto("/console/");
    await page.getByRole("button", { name: /Меню аккаунта:/ }).tap();
    await page.getByRole("menuitemradio", { name: "Тёмная тема" }).tap();
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("heading", { name: "Диалоги" }).tap();
    await expect(page.getByRole("menu")).toHaveCount(0);
  });
});
