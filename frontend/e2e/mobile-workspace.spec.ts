import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { PASSWORD, SESSION_COOKIE, expect, scenario, test } from "./fixtures";

// The narrow screens' workspace (workspace/AppBar.vue, MobileMenu.vue, tickets/TicketSidebar.vue): one
// compact app bar row with the menu and the current project, a drawer with the project choice,
// administration by role, the quick replies catalog and the account; no account footer under the list.
// Measured in the real layout at 320, 375 and 430 px; every test also fails on a CSP violation or a
// console error.
const menuButton = (page: Page) => page.getByRole("button", { name: /^Меню\. Проект:/ });
const drawer = (page: Page) => page.getByRole("dialog", { name: "Resolvate" });
const bar = (page: Page) => page.getByRole("banner", { name: "Проект и управление" });
const list = (page: Page) => page.getByRole("listbox", { name: "Диалоги" });
const composer = (page: Page) => page.getByRole("textbox", { name: "Текст ответа" });

async function start(page: Page, context: BrowserContext, request: APIRequestContext, data: object = {}): Promise<void> {
  await scenario(request, { me: "session", data });
  await context.addCookies([SESSION_COOKIE]);
  await page.goto("/console/");
  await expect(list(page).getByRole("option").first()).toBeVisible();
}

async function openDrawer(page: Page): Promise<void> {
  await menuButton(page).click();
  await expect(drawer(page)).toBeVisible();
}

for (const width of [320, 375, 430]) {
  test(`at ${width} px the app bar is one compact row and the list gets the height`, async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await page.setViewportSize({ width, height: 740 });
    await start(page, context, request);
    const header = (await bar(page).boundingBox())!;
    expect(header.height).toBeLessThanOrEqual(64);
    // The current project is named in the bar; the brand, the caption and the desktop controls are not shown.
    await expect(menuButton(page)).toHaveAccessibleName("Меню. Проект: Поддержка");
    await expect(menuButton(page)).toContainText("Поддержка");
    await expect(bar(page).getByText("Текущий проект")).toBeHidden();
    await expect(bar(page).getByText("Resolvate")).toBeHidden();
    await expect(page.getByRole("button", { name: "Управление готовыми ответами" })).toBeHidden();
    // No account footer under the list on a phone.
    await expect(page.getByRole("button", { name: /^Меню аккаунта:/ })).toBeHidden();
    const button = (await menuButton(page).boundingBox())!;
    expect(button.height).toBeGreaterThanOrEqual(44);
    expect(button.width).toBeGreaterThanOrEqual(44);
    // The blocks above the list keep one spacing scale, and the list takes the rest of the screen.
    const gaps = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const header = box("header.chrome");
      // The title's row is as tall as the archive button beside it.
      const title = box("#ticket-sidebar header button");
      const search = box(".search-field");
      const tabs = box('[role="tablist"][aria-label="Папки диалогов"]');
      const rows = box("#ticket-list");
      return { title: title.top - header.bottom, search: search.top - title.bottom, tabs: tabs.top - search.bottom, list: rows.top - tabs.bottom, rows: rows.height };
    });
    expect(gaps.title).toBe(8);
    expect(gaps.search).toBe(4);
    // The tabs' row starts 4 px under the search field: its padding, part of the row (the wheel area).
    expect(gaps.tabs).toBe(4);
    expect(gaps.list).toBeLessThanOrEqual(6);
    expect(gaps.rows).toBeGreaterThanOrEqual(740 * 0.7);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

test("a long project name is cut in the bar and keeps the button inside the screen", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  const name = "Очень длинное название проекта поддержки клиентов ".repeat(3).trim();
  await page.route("**/console/projects", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const projects = (await response.json()) as { id: string; name: string }[];
    await route.fulfill({ response, json: projects.map((project) => (project.id === "p1" ? { ...project, name } : project)) });
  });
  await page.setViewportSize({ width: 320, height: 640 });
  await start(page, context, request);
  await expect(menuButton(page)).toHaveAccessibleName(`Меню. Проект: ${name}`);
  const label = menuButton(page).getByText(name);
  expect(await label.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  const box = (await menuButton(page).boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("the drawer: Esc and the backdrop close it, the focus goes back to the menu button", async ({ page, context, request, consoleErrors, attachScreenshot, browserName }, testInfo) => {
  void consoleErrors;
  await page.setViewportSize({ width: 375, height: 740 });
  await start(page, context, request);
  await openDrawer(page);
  // Focus is inside the drawer and stays there.
  await expect.poll(() => drawer(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await expect(drawer(page).getByRole("radio", { name: "Поддержка" })).toHaveAttribute("aria-checked", "true");
  await expect(drawer(page).getByRole("button", { name: "Каталог готовых ответов" })).toBeVisible();
  await expect(drawer(page).getByRole("button", { name: /^Меню аккаунта: Оператор Тест, Оператор/ })).toBeVisible();
  // An operator administers nothing: no administration section.
  await expect(drawer(page).getByRole("heading", { name: "Управление" })).toHaveCount(0);
  await expect.poll(async () => (await drawer(page).boundingBox())!.x).toBe(0);
  expect((await drawer(page).boundingBox())!.height).toBe(740);
  await page.waitForTimeout(200);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    await attachScreenshot(`drawer-375-${theme}`);
    if (browserName === "chromium") await page.screenshot({ path: testInfo.outputPath(`drawer-375-${theme}.png`) });
  }
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toBeHidden();
  await expect(menuButton(page)).toBeFocused();
  await openDrawer(page);
  await page.mouse.click(370, 400);
  await expect(drawer(page)).toBeHidden();
  await expect(menuButton(page)).toBeFocused();
});

test("another project chosen in the drawer: the drawer closes, the bar and the list follow, drafts stay", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await page.setViewportSize({ width: 375, height: 740 });
  await start(page, context, request);
  await list(page).getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(composer(page)).toBeEditable();
  await composer(page).fill("Черновик для Анны");
  // From the open dialogue, without going back to the list.
  await openDrawer(page);
  await drawer(page).getByRole("radio", { name: "Второй проект" }).click();
  await expect(drawer(page)).toBeHidden();
  await expect(menuButton(page)).toHaveAccessibleName("Меню. Проект: Второй проект");
  await expect(list(page).getByRole("option", { name: /Григорий из второго/ })).toBeVisible();
  await openDrawer(page);
  await drawer(page).getByRole("radio", { name: "Поддержка" }).click();
  await list(page).getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(composer(page)).toHaveValue("Черновик для Анны");
});

test("while a reply is being sent the drawer says the project cannot change, and does not change it", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await page.setViewportSize({ width: 375, height: 740 });
  await start(page, context, request);
  await list(page).getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(composer(page)).toBeEditable();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/console/projects/p1/tickets/t1/send", async (route) => {
    await held;
    await route.continue();
  });
  await composer(page).fill("Ответ");
  await composer(page).press("Enter");
  await expect(composer(page)).toBeDisabled();
  await openDrawer(page);
  await expect(drawer(page).getByText("Идёт отправка: проект можно сменить после неё.")).toBeVisible();
  await expect(drawer(page).getByRole("radio", { name: "Второй проект" })).toBeDisabled();
  await page.keyboard.press("Escape");
  release();
  await expect(composer(page)).toHaveValue("");
  await expect(menuButton(page)).toHaveAccessibleName("Меню. Проект: Поддержка");
});

test("the catalog of quick replies opens from the drawer and gives the focus back to the menu button", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await page.setViewportSize({ width: 375, height: 740 });
  await start(page, context, request);
  await openDrawer(page);
  await drawer(page).getByRole("button", { name: "Каталог готовых ответов" }).click();
  const catalog = page.getByRole("dialog", { name: "Готовые ответы" });
  await expect(catalog).toBeVisible();
  await expect(drawer(page)).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(catalog).toBeHidden();
  await expect(menuButton(page)).toBeFocused();
});

test("administration by role: the installation administrator gets projects and staff, a window from the drawer returns the focus", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await page.setViewportSize({ width: 375, height: 740 });
  await start(page, context, request, { account: "admin" });
  await openDrawer(page);
  await expect(drawer(page).getByRole("heading", { name: "Управление" })).toBeVisible();
  await expect(drawer(page).getByRole("button", { name: "Сотрудники" })).toBeVisible();
  await drawer(page).getByRole("button", { name: "Проекты" }).click();
  const projects = page.getByRole("dialog", { name: "Проекты" });
  await expect(projects).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(projects).toBeHidden();
  await expect(menuButton(page)).toBeFocused();
  await openDrawer(page);
  await drawer(page).getByRole("button", { name: "Сотрудники" }).click();
  await expect(page.getByRole("dialog", { name: "Сотрудники" })).toBeVisible();
});

test("sign-out from the drawer asks before removing the drafts, as from the desktop footer", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await page.setViewportSize({ width: 375, height: 740 });
  await start(page, context, request);
  await list(page).getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(composer(page)).toBeEditable();
  await composer(page).fill("Не потерять");
  await openDrawer(page);
  await drawer(page).getByRole("button", { name: /^Меню аккаунта:/ }).click();
  await expect(page.getByRole("menuitem", { name: "Сменить пароль" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Выйти" }).click();
  const ask = page.getByRole("alertdialog", { name: "Выйти и удалить черновики?" });
  await expect(ask).toContainText("черновики (1)");
  await ask.getByRole("button", { name: "Остаться" }).click();
  await expect(ask).toBeHidden();
  await expect(page.locator("#workspace")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toBeHidden();
  await expect(composer(page)).toHaveValue("Не потерять");
  await openDrawer(page);
  await drawer(page).getByRole("button", { name: /^Меню аккаунта:/ }).click();
  await page.getByRole("menuitem", { name: "Выйти" }).click();
  await ask.getByRole("button", { name: "Выйти и удалить" }).click();
  await expect(page.locator("#login-screen")).toBeVisible();
  await page.locator('input[name="login"]').fill("operator");
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await list(page).getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(composer(page)).toHaveValue("");
});

test("a sign-out that fails after the drawer was closed still says why, on the screen", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await page.setViewportSize({ width: 375, height: 740 });
  await start(page, context, request);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/console/logout", async (route) => {
    await pending;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "Попробуйте позже." }) });
  });
  await openDrawer(page);
  await drawer(page).getByRole("button", { name: /Меню аккаунта:/ }).click();
  const sent = page.waitForRequest(request => request.url().endsWith("/console/logout"));
  await page.getByRole("menuitem", { name: "Выйти" }).click();
  // The menu, then the drawer close while the request runs: the account menu leaves the page.
  await sent;
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toBeHidden();
  release();
  await expect(page.getByRole("alert")).toHaveText("Попробуйте позже.");
  await expect(page.getByRole("alert")).toBeInViewport();
  await expect(list(page)).toBeVisible();
});

test("on the desktop nothing moved: the project picker and the account footer, no menu button", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await page.setViewportSize({ width: 1280, height: 800 });
  await start(page, context, request);
  await expect(menuButton(page)).toBeHidden();
  await expect(page.getByRole("button", { name: /^Текущий проект/ })).toBeVisible();
  await expect(bar(page).getByText("Resolvate")).toBeVisible();
  await expect(page.getByRole("button", { name: "Управление готовыми ответами" })).toHaveText("Готовые ответы");
  await expect(page.getByRole("button", { name: /^Меню аккаунта:/ })).toBeVisible();
  expect((await bar(page).boundingBox())!.height).toBeGreaterThanOrEqual(76);
});

test("project radios have one Tab stop and arrow keys select the next project", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await page.setViewportSize({ width: 375, height: 740 });
  await start(page, context, request);
  await openDrawer(page);
  const selected = drawer(page).getByRole("radio", { name: "Поддержка", exact: true });
  const other = drawer(page).getByRole("radio", { name: "Второй проект" });
  // Reka's group is the entry Tab stop; entering it focuses the checked item.
  await drawer(page).getByRole("button", { name: "Закрыть меню" }).focus();
  await page.keyboard.press("Tab");
  await expect(selected).toBeFocused();
  await expect(selected).toHaveAttribute("tabindex", "0");
  await expect(other).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("ArrowDown");
  await expect(drawer(page)).toBeHidden();
  await expect(menuButton(page)).toHaveAccessibleName("Меню. Проект: Второй проект");
  await expect(menuButton(page)).toBeFocused();
  await openDrawer(page);
  await expect(other).toHaveAttribute("aria-checked", "true");
  await other.focus();
  await page.keyboard.press("Tab");
  await expect(drawer(page).getByRole("button", { name: "Каталог готовых ответов" })).toBeFocused();
});

test("reopening the drawer cannot duplicate logout; an error survives a later dismissal", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await page.setViewportSize({ width: 375, height: 740 });
  await start(page, context, request);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  await page.route("**/console/logout", async route => {
    calls++;
    await held;
    await route.fulfill({ status: 500, json: { detail: "Выход временно недоступен." } });
  });
  await openDrawer(page);
  await drawer(page).getByRole("button", { name: /^Меню аккаунта:/ }).click();
  await page.getByRole("menuitem", { name: "Выйти" }).click();
  await expect.poll(() => calls).toBe(1);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toBeHidden();
  await openDrawer(page);
  await drawer(page).getByRole("button", { name: /^Меню аккаунта:/ }).click();
  await expect(page.getByRole("menuitem", { name: "Выходим…" })).toBeDisabled();
  release();
  await expect(page.getByRole("menuitem", { name: "Выйти" })).toBeEnabled();
  expect(calls).toBe(1);
  // Retry in the new instance: the refusal arrives before the drawer is dismissed this time.
  await page.getByRole("menuitem", { name: "Выйти" }).click();
  await expect(page.locator(".account-error")).toHaveText("Выход временно недоступен.");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toBeHidden();
  await expect(page.getByRole("alert")).toHaveText("Выход временно недоступен.");
  await expect(page.getByRole("alert")).toBeInViewport();
  await expect(list(page)).toBeVisible();
  expect(calls).toBe(2);
});

test.describe("forced colors", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "forced colors are emulated in Chromium only");

  test("the placeholders and the drawer keep visible edges", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await page.emulateMedia({ forcedColors: "active" });
    await page.setViewportSize({ width: 375, height: 740 });
    let open!: () => void;
    const held = new Promise<void>((resolve) => { open = resolve; });
    await page.route("**/console/projects", async (route) => {
      await held;
      await route.continue();
    });
    await scenario(request, { me: "session" });
    await context.addCookies([SESSION_COOKIE]);
    await page.goto("/console/");
    // The project's placeholder has no colour of its own here: its border shows it.
    const placeholder = bar(page).locator(".skeleton").first();
    await expect(placeholder).toBeVisible();
    await expect(placeholder).toHaveCSS("border-top-width", "1px");
    open();
    await expect(menuButton(page)).toHaveAccessibleName("Меню. Проект: Поддержка");
    await openDrawer(page);
    await expect(drawer(page)).toHaveCSS("border-right-width", "1px");
    await expect(drawer(page).getByRole("radio", { name: /Поддержка/ })).toHaveAttribute("aria-checked", "true");
  });
});
