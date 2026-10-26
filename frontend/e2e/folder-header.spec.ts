import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, test } from "./fixtures";

// The dialogue's folder in its header (chat/DialogueHeader.vue, folders/TicketFolderMenu.vue): a menu button with the
// folder's name at the right, before close or reopen; where the header is short (a phone, a narrow dialogue panel) an
// icon button named by the folder, the folder's name seen under the customer's. No row of its own, no «Папка»
// caption; the history gets the room. Saving says so in a note under the header that takes no room; a failure
// stays. Real layout; every test also fails on a CSP violation or a console error.
const LONG_NAME = "Анна-Мария Константинопольская-Достоевская";
const LONG_FOLDER = "Постоянные клиенты с расширенной поддержкой";
const header = (page: Page) => page.locator("#customer-open").locator("xpath=ancestor::header[1]");
const folder = (page: Page) => header(page).getByRole("button", { name: /^Папка диалога: / });
const close = (page: Page) => header(page).getByRole("button", { name: /^(Завершить|Возобновить)$/ });
const status = (page: Page) => page.locator(".folder-status");
const list = (page: Page) => page.getByRole("listbox", { name: "Диалоги" });

async function start(page: Page, context: BrowserContext, request: APIRequestContext, width: number, height = 740): Promise<void> {
  await page.setViewportSize({ width, height });
  await scenario(request, { me: "session" });
  await context.addCookies([SESSION_COOKIE]);
  await page.goto("/console/");
}

async function open(page: Page, name: RegExp): Promise<void> {
  await list(page).getByRole("option", { name }).click();
  await expect(page.getByRole("textbox", { name: "Текст ответа" })).toBeEditable();
}

function layout(page: Page) {
  return page.evaluate(() => {
    const top = document.querySelector("#customer-open")!.closest("header")!.getBoundingClientRect();
    const view = document.querySelector<HTMLElement>(".messages")!;
    return {
      header: Math.round(top.height),
      // The history starts right under the header: no row in between.
      gap: Math.round(view.getBoundingClientRect().top - top.bottom),
      history: view.clientHeight,
      composer: Math.round(document.querySelector(".composer")!.getBoundingClientRect().top),
      fromEnd: Math.round(view.scrollHeight - view.scrollTop - view.clientHeight),
    };
  });
}

test("on a wide screen the folder is a menu button in the header before «Завершить», with no row or caption of its own", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await start(page, context, request, 1280);
  await open(page, /Борис Петров/);
  await expect(folder(page)).toHaveAccessibleName("Папка диалога: VIP");
  await expect(folder(page)).toHaveText("VIP");
  const [button, action] = [(await folder(page).boundingBox())!, (await close(page).boundingBox())!];
  expect(button.x + button.width).toBeLessThanOrEqual(action.x);
  expect(button.height).toBe(44);
  const geometry = await layout(page);
  expect(geometry.header).toBe(76);
  expect(geometry.gap).toBe(0);
  // The 740 px window of the audit: 392 px of history with the folder's row, 53 px more without it.
  expect(geometry.history).toBe(445);
  await expect(page.getByText("Папка", { exact: true })).toHaveCount(0);
  // Anna has none: said once her detail is in.
  await open(page, /Анна Смирнова/);
  await expect(folder(page)).toHaveAccessibleName("Папка диалога: Без папки");
});

for (const width of [1100, 900, 701]) {
  test(`at ${width} px the folder and the customer's name share the header without overflow`, async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await page.route("**/console/projects/p1/tickets/t2", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), display_name: LONG_NAME } });
    });
    await start(page, context, request, width);
    await open(page, /Борис Петров/);
    await expect(folder(page)).toBeVisible();
    const name = await header(page).locator("strong").evaluate((element) => element.getBoundingClientRect().width);
    expect(name).toBeGreaterThan(80);
    await expect(close(page)).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect((await layout(page)).header).toBe(76);
  });
}

for (const width of [375, 320]) {
  test(`at ${width} px the folder is a 44×44 icon named by the folder, its name seen under the customer's`, async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await page.route("**/console/projects/p1/tickets/t2", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), display_name: LONG_NAME } });
    });
    await page.route("**/console/projects/p1/folders", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const folders = (await response.json()) as { id: string; name: string }[];
      await route.fulfill({ response, json: folders.map((item) => (item.id === "f1" ? { ...item, name: LONG_FOLDER } : item)) });
    });
    await start(page, context, request, width);
    await open(page, /Борис Петров/);
    await expect(folder(page)).toHaveAccessibleName(`Папка диалога: ${LONG_FOLDER}`);
    const button = (await folder(page).boundingBox())!;
    expect([button.width, button.height]).toEqual([44, 44]);
    // Seen beside the channel, not read twice.
    const meta = header(page).locator("#customer-open .muted");
    await expect(meta).toContainText("Постоян");
    expect(await meta.locator(":scope > [aria-hidden='true']").count()).toBe(1);
    const name = await header(page).locator("strong").evaluate((element) => element.getBoundingClientRect().width);
    expect(name).toBeGreaterThan(80);
    for (const control of [page.getByRole("button", { name: "К списку диалогов" }), folder(page), close(page)]) {
      await expect(control).toBeInViewport({ ratio: 1 });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const geometry = await layout(page);
    expect(geometry.header).toBe(72);
    expect(geometry.gap).toBe(0);
    expect(geometry.history).toBe(539);
    // The same menu as on a wide screen, inside the screen.
    await folder(page).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitemradio", { name: LONG_FOLDER })).toHaveAttribute("aria-checked", "true");
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
  });
}

test("choosing and clearing the folder: saved for the team, said briefly, the list follows, the history stays put", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await start(page, context, request, 1280);
  await open(page, /Анна Смирнова/);
  const before = await layout(page);
  expect(before.fromEnd).toBeLessThanOrEqual(1);
  await folder(page).click();
  await page.getByRole("menuitemradio", { name: "VIP" }).click();
  await expect(status(page)).toHaveText("Сохранено для команды");
  await expect(status(page)).toHaveAttribute("data-kind", "done");
  await expect(folder(page)).toHaveAccessibleName("Папка диалога: VIP");
  expect(await layout(page)).toEqual(before);
  await page.getByRole("tab", { name: "VIP" }).click();
  await expect(list(page).getByRole("option", { name: /Анна Смирнова/ })).toBeVisible();
  // A success goes by itself.
  await expect(status(page)).toHaveText("", { timeout: 6000 });
  await folder(page).click();
  await page.getByRole("menuitemradio", { name: "Без папки" }).click();
  await expect(folder(page)).toHaveAccessibleName("Папка диалога: Без папки");
  await expect(list(page).getByRole("option", { name: /Анна Смирнова/ })).toHaveCount(0);
});

test("a conflicting change and a failed save are said and stay; the folder shown is the server's", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  let answer = { status: 409, detail: "Папку диалога уже изменил другой оператор. Обновите и попробуйте снова." };
  await page.route("**/console/projects/p1/tickets/t1/folder", (route) => route.fulfill({ status: answer.status, json: { detail: answer.detail } }));
  await start(page, context, request, 1280);
  await open(page, /Анна Смирнова/);
  const before = await layout(page);
  await folder(page).click();
  await page.getByRole("menuitemradio", { name: "VIP" }).click();
  await expect(status(page)).toHaveText(answer.detail);
  await expect(status(page)).toHaveAttribute("data-kind", "error");
  await expect(status(page)).toBeVisible();
  await expect(folder(page)).toHaveAccessibleName("Папка диалога: Без папки");
  await page.waitForTimeout(4000);
  await expect(status(page)).toHaveText(answer.detail);
  expect(await layout(page)).toEqual(before);
  answer = { status: 500, detail: "Не удалось перенести диалог." };
  await folder(page).click();
  await page.getByRole("menuitemradio", { name: "VIP" }).click();
  await expect(status(page)).toHaveText("Не удалось перенести диалог.");
  await expect(status(page)).toHaveAttribute("data-kind", "error");
});

for (const [device, width] of [["wide", 1280], ["phone", 375]] as const) {
  test(`${device}: until the detail comes the folder is a placeholder of its size, never «Без папки»`, async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await start(page, context, request, width);
    await page.route("**/console/projects/p1/tickets/t2", async (route) => {
      await held;
      await route.continue();
    });
    await list(page).getByRole("option", { name: /Борис Петров/ }).click();
    const placeholder = header(page).locator(device === "wide" ? ".folder-select-skeleton" : ".folder-icon-skeleton");
    await expect(placeholder).toBeVisible();
    await expect(folder(page)).toHaveCount(0);
    await expect(header(page)).not.toContainText("Без папки");
    const height = (await layout(page)).header;
    release();
    await expect(folder(page)).toHaveAccessibleName("Папка диалога: VIP");
    await expect(placeholder).toHaveCount(0);
    expect((await layout(page)).header).toBe(height);
  });
}

test("keyboard: Tab reaches the folder, Enter opens it, arrows and Enter choose, the focus comes back; Esc closes", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await start(page, context, request, 1280);
  await open(page, /Анна Смирнова/);
  await page.locator("#customer-open").focus();
  await page.keyboard.press("Tab");
  await expect(folder(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitemradio", { name: "Без папки" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(folder(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitemradio", { name: "VIP" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(folder(page)).toBeFocused();
  await expect(folder(page)).toHaveAccessibleName("Папка диалога: VIP");
});

test("screenshots: wide and phone, light and dark, the open menu and a failure", async ({ page, context, request, consoleErrors, attachScreenshot, browserName }, testInfo) => {
  void consoleErrors;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/console/projects/p1/tickets/t2", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), display_name: LONG_NAME } });
  });
  const shoot = async (name: string) => {
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await attachScreenshot(`${name}-${theme}`);
      if (browserName === "chromium") await page.screenshot({ path: testInfo.outputPath(`${name}-${theme}.png`) });
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  };
  await start(page, context, request, 1280);
  await open(page, /Борис Петров/);
  await shoot("folder-wide");
  await folder(page).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await shoot("folder-wide-menu");
  await page.keyboard.press("Escape");
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 740 });
    await expect(folder(page)).toBeVisible();
    await shoot(`folder-phone-${width}`);
  }
  await folder(page).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await shoot("folder-phone-menu");
});
