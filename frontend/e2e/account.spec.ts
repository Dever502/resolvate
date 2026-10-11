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

test("menu width follows labels within limits and wraps oversized action text", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/console/");
  await page.getByRole("button", { name: /Меню аккаунта:/ }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect.poll(async () => (await menu.boundingBox())!.width).toBe(288);

  // Exercise future labels without adding a fictitious settings action to the product.
  const label = page.locator(".account-logout");
  await label.evaluate(element => {
    element.textContent = "Настройки уведомлений и автоматизации";
  });
  await expect.poll(async () => (await menu.boundingBox())!.width).toBeGreaterThan(288);
  expect((await menu.boundingBox())!.width).toBeLessThanOrEqual(416);
  await label.evaluate(element => {
    const text = document.createElement("span");
    text.textContent = "ОченьДлинноеНазваниеДействия".repeat(15);
    element.replaceChildren(text);
  });
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(async () => (await menu.boundingBox())!.width).toBe(Math.min(416, width - 16));
    await expect.poll(() => menu.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await label.evaluate(element => element.scrollHeight)).toBeGreaterThan(44);
    const bounds = (await menu.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(8);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 8);
  }
});

test("a long unbroken identity stays capped and ellipsized", async ({ page }) => {
  const name = `${"account".repeat(50)}@example.test`;
  await page.route("**/console/me", async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, account: { ...body.account, name } } });
  });
  await page.goto("/console/");
  await page.getByRole("button", { name: /Меню аккаунта:/ }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  expect((await menu.boundingBox())!.width).toBeLessThanOrEqual(416);
  const identity = page.locator(".account-identity strong");
  await expect(identity).toHaveAttribute("title", name);
  expect(await identity.evaluate(element => ({
    clipped: element.scrollWidth > element.clientWidth,
    overflow: getComputedStyle(element).textOverflow,
  }))).toEqual({ clipped: true, overflow: "ellipsis" });
  expect(await menu.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("growing menu scrolls inside available height and keeps keyboard actions reachable", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 400 });
  await page.goto("/console/");
  const trigger = page.getByRole("button", { name: /Меню аккаунта:/ });
  await trigger.press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  // Synthetic informational rows test growth; real Reka items still handle focus/navigation.
  await page.locator(".account-identity").evaluate(identity => {
    for (let index = 0; index < 20; index++) {
      const row = document.createElement("div");
      row.className = "menu-item";
      row.textContent = `Дополнительный пункт ${index + 1}`;
      identity.after(row);
    }
  });
  await expect.poll(() => menu.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect.poll(async () => (await menu.boundingBox())!.y).toBeGreaterThanOrEqual(8);
  expect((await menu.boundingBox())!.y + (await menu.boundingBox())!.height).toBeLessThanOrEqual(392);
  await expect(menu).toHaveAttribute("data-side", "top");
  await page.keyboard.press("End");
  const logout = page.getByRole("menuitem", { name: "Выйти" });
  await expect(logout).toBeFocused();
  await expect(logout).toBeInViewport();
  await expect.poll(() => menu.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

for (const width of [320, 375, 1280]) {
  for (const mode of ["light", "dark"] as const) {
    test(`menu bounds and ${mode} screenshot at ${width}px`, async ({ page, context, attachScreenshot }) => {
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
      const footer = (await page.locator("footer").boundingBox())!;
      // Keep the lower menu border clear of the sidebar/footer divider, not only the trigger.
      expect(footer.y - (bounds!.y + bounds!.height)).toBeGreaterThanOrEqual(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await attachScreenshot(`account-${mode}-${width}.png`);
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
