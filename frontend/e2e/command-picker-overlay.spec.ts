import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, stubLog, test } from "./fixtures";

// The commands (composer/CommandPicker.vue) are one pop-up over the reply box, as the quick replies: no state of a
// command (list, hint, error, result) takes room in the reply area, so the history and the reply box keep their
// size and place, the operator keeps their place in the history, and no read receipt follows. Real geometry in a
// real layout; every test also fails on a CSP violation or a console error.
const COMMANDS = [
  { name: "info", description: "Информация о клиенте", arguments: "", mutation: false },
  { name: "subinfo", description: "Подписка Remnawave", arguments: "", mutation: false },
  { name: "gift", description: "Продлить подписку", arguments: "<дни: 1–9999>", mutation: true },
  { name: "note", description: "Добавить внутреннюю заметку", arguments: "<текст>", mutation: true },
];
const LONG = Array.from({ length: 60 }, (_, index) => `Строка результата ${index + 1}: устройство, ключ, срок действия подписки`).join("\n");

const input = (page: Page) => page.getByRole("textbox", { name: "Текст ответа" });
const popup = (page: Page) => page.locator(".command-options");
const history = (page: Page) => page.getByRole("region", { name: "Переписка" });

async function start(page: Page, context: BrowserContext, request: APIRequestContext): Promise<void> {
  await scenario(request, { me: "session" });
  await context.addCookies([SESSION_COOKIE]);
  await page.route("**/console/projects/*/commands", (route) => route.fulfill({ json: COMMANDS }));
  await page.route("**/tickets/*/commands/info", (route) => route.fulfill({ json: { status: "completed", message: "Клиент: Анна Смирнова\nКанал: Telegram" } }));
  await page.route("**/tickets/*/commands/subinfo", (route) => route.fulfill({ json: { status: "completed", message: LONG } }));
  await page.route("**/tickets/*/commands/gift", (route) => route.fulfill({ status: 503, json: { detail: "Remnawave не ответила. Повторите позже." } }));
  await page.route("**/tickets/*/commands/note", (route) => route.abort("connectionreset"));
  await page.goto("/console/");
  await page.getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(input(page)).toBeEditable();
}

/** The conversation column: the history's view and place, the reply area, the reply box. */
function layout(page: Page) {
  return page.evaluate(() => {
    const view = document.querySelector<HTMLElement>(".messages")!;
    const area = document.querySelector<HTMLElement>(".composer-area")!;
    const form = document.querySelector<HTMLElement>(".composer")!;
    const top = view.getBoundingClientRect().top;
    const first = [...view.querySelectorAll("article")].find((article) => article.getBoundingClientRect().bottom > top);
    const last = view.querySelector("article:last-of-type")!.getBoundingClientRect();
    return {
      history: view.clientHeight,
      area: area.getBoundingClientRect().height,
      composerTop: form.getBoundingClientRect().top,
      fromEnd: Math.round(view.scrollHeight - view.scrollTop - view.clientHeight),
      firstTop: first ? Math.round(first.getBoundingClientRect().top - top) : null,
      lastBottom: Math.round(last.bottom),
    };
  });
}

/** The pop-up is on the screen and above the reply area. */
async function expectPopupOnScreen(page: Page, width: number): Promise<void> {
  const box = (await popup(page).boundingBox())!;
  const area = (await page.locator(".composer-area").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(area.y);
}

for (const [width, height] of [[1280, 800], [375, 812], [320, 640]] as const) {
  for (const place of ["end", "above"] as const) {
    test(`at ${width}×${height}, reading at the ${place === "end" ? "end" : "older messages"}: no state of a command moves the history or the reply box`, async ({ page, context, request, consoleErrors }) => {
      void consoleErrors;
      await page.setViewportSize({ width, height });
      await start(page, context, request);
      if (place === "above") {
        await history(page).evaluate((element) => { element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 200); });
        await expect.poll(async () => (await layout(page)).fromEnd).toBeGreaterThan(100);
      } else {
        await expect.poll(async () => (await layout(page)).fromEnd).toBeLessThanOrEqual(1);
      }
      const since = Date.now();
      const before = await layout(page);
      const same = async (state: string) => {
        await expect.poll(() => layout(page), { message: state }).toEqual(before);
      };

      await input(page).fill("/");
      await expect(page.getByRole("listbox", { name: "Доступные команды" }).getByRole("option")).toHaveCount(4);
      await expectPopupOnScreen(page, width);
      await same("the list");
      await input(page).fill("/gi");
      await expect(page.getByRole("listbox", { name: "Доступные команды" }).getByRole("option")).toHaveCount(1);
      await same("a filtered list");
      await input(page).fill("/gift ");
      await expect(popup(page).locator(".command-hint")).toContainText("/gift <дни: 1–9999> — Продлить подписку");
      await expectPopupOnScreen(page, width);
      await same("the hint of a chosen command");
      await input(page).press("Enter");
      await expect(popup(page).getByRole("alert")).toContainText("Формат: /gift <дни: 1–9999>");
      await same("a format error");
      await input(page).fill("/gift 30");
      await input(page).press("Enter");
      await expect(popup(page).getByRole("alert")).toContainText("Remnawave не ответила");
      await expectPopupOnScreen(page, width);
      await same("an error of the server");
      await input(page).fill("/info");
      await input(page).press("Escape");
      await input(page).press("Enter");
      await expect(popup(page).getByRole("status", { name: "Результат команды" })).toHaveText("Клиент: Анна Смирнова\nКанал: Telegram");
      await same("a short result");
      await input(page).fill("/subinfo");
      await input(page).press("Escape");
      await input(page).press("Enter");
      const result = popup(page).getByRole("status", { name: "Результат команды" });
      await expect(result).toContainText("Строка результата 60");
      await expectPopupOnScreen(page, width);
      await same("a long result");
      // The long result scrolls inside the pop-up, to its last line, and its buttons stay below it.
      const body = popup(page).locator(".reply-options-body");
      expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect(result.getByText("Строка результата 60", { exact: false })).toBeInViewport();
      await expect(popup(page).getByRole("button", { name: "Новая команда" })).toBeInViewport({ ratio: 1 });
      await input(page).press("Escape");
      await expect(popup(page)).toHaveCount(0);
      await expect(input(page)).toHaveValue("/subinfo");
      await same("the pop-up put away");
      // The pop-up never sent a read receipt: the operator's place did not change.
      expect((await stubLog(request)).filter((entry) => entry.at >= since && /\/read\//.test(entry.path))).toEqual([]);
    });
  }
}

test("keyboard and screen readers: focus stays in the reply box, the active option is named and in view, Escape keeps the text", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await page.setViewportSize({ width: 375, height: 640 });
  await start(page, context, request);
  await input(page).fill("/");
  const list = page.getByRole("listbox", { name: "Доступные команды" });
  await expect(list.getByRole("option")).toHaveCount(4);
  const listId = await list.getAttribute("id");
  await expect(input(page)).toHaveAttribute("aria-controls", listId!);
  await expect(input(page)).toHaveAttribute("aria-activedescendant", `${listId}-0`);
  for (const index of [1, 2, 3]) {
    await input(page).press("ArrowDown");
    await expect(input(page)).toHaveAttribute("aria-activedescendant", `${listId}-${index}`);
    await expect(list.getByRole("option").nth(index)).toHaveAttribute("aria-selected", "true");
    await expect(list.getByRole("option").nth(index)).toBeInViewport({ ratio: 1 });
    await expect(input(page)).toBeFocused();
  }
  await input(page).press("ArrowUp");
  await input(page).press("Enter");
  await expect(input(page)).toHaveValue("/gift ");
  await expect(input(page)).not.toHaveAttribute("aria-controls");
  // Without the list, Escape puts away the hint; the text stays and nothing of the pop-up is left to take a click.
  await input(page).press("Escape");
  await expect(popup(page)).toHaveCount(0);
  await expect(input(page)).toHaveValue("/gift ");
  await expect(input(page)).toBeFocused();
  // Typing brings it back; the close button puts it away and gives the focus back to the reply box.
  await input(page).press("3");
  await expect(popup(page).locator(".command-hint")).toBeVisible();
  await popup(page).getByRole("button", { name: "Закрыть команды" }).click();
  await expect(popup(page)).toHaveCount(0);
  await expect(input(page)).toBeFocused();
  // A result is reached with the keyboard, read out by its name, and Escape on it puts it away.
  await input(page).fill("/info");
  await input(page).press("Escape");
  await input(page).press("Enter");
  const result = popup(page).getByRole("status", { name: "Результат команды" });
  await expect(result).toBeVisible();
  await result.focus();
  await page.keyboard.press("Escape");
  await expect(popup(page)).toHaveCount(0);
  await expect(input(page)).toBeFocused();
  await expect(input(page)).toHaveValue("/info");
});

test("a lost answer of a changing command keeps its warning in the pop-up, and the retry uses the same key", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await start(page, context, request);
  const keys: string[] = [];
  await page.unroute("**/tickets/*/commands/note");
  await page.route("**/tickets/*/commands/note", async (route) => {
    keys.push(route.request().headers()["x-idempotency-key"]!);
    if (keys.length === 1) await route.abort("connectionreset");
    else await route.fulfill({ json: { status: "completed", message: "Заметка добавлена." } });
  });
  const before = await layout(page);
  await input(page).fill("/note передать бухгалтерии");
  await input(page).press("Enter");
  await expect(popup(page).getByRole("alert")).toContainText("Повторная отправка использует прежний ключ");
  expect(await layout(page)).toEqual(before);
  await input(page).press("Enter");
  await expect(popup(page).getByRole("status", { name: "Результат команды" })).toHaveText("Заметка добавлена.");
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect((await stubLog(request)).filter((entry) => entry.path.endsWith("/send"))).toEqual([]);
});

test("a tap on the history puts the list away but keeps a result; another dialogue shows no stale result", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await start(page, context, request);
  await input(page).fill("/info");
  await expect(page.getByRole("listbox", { name: "Доступные команды" })).toBeVisible();
  await page.mouse.click(600, 400);
  await expect(page.getByRole("listbox", { name: "Доступные команды" })).toHaveCount(0);
  await input(page).press("Enter");
  const result = popup(page).getByRole("status", { name: "Результат команды" });
  await expect(result).toContainText("Клиент: Анна Смирнова");
  await history(page).click({ position: { x: 20, y: 20 } });
  await expect(result).toContainText("Клиент: Анна Смирнова");
  await page.getByRole("option", { name: /Борис Петров/ }).click();
  await expect(input(page)).toBeEditable();
  await expect(popup(page)).toHaveCount(0);
  await page.getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(input(page)).toHaveValue("/info");
  await expect(popup(page).locator(".command-result[data-filled]")).toHaveCount(0);
});

test("screenshots: the list, a hint, an error and a long result, desktop and phone, light and dark", async ({ page, context, request, consoleErrors, attachScreenshot, browserName }, testInfo) => {
  void consoleErrors;
  await page.emulateMedia({ reducedMotion: "reduce" });
  const shoot = async (name: string) => {
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await attachScreenshot(`${name}-${theme}`);
      if (browserName === "chromium") await page.screenshot({ path: testInfo.outputPath(`${name}-${theme}.png`) });
    }
  };
  for (const [device, width, height] of [["desktop", 1280, 800], ["phone", 375, 812]] as const) {
    await page.setViewportSize({ width, height });
    if (device === "desktop") await start(page, context, request);
    await input(page).fill("/");
    await expect(page.getByRole("listbox", { name: "Доступные команды" }).getByRole("option")).toHaveCount(4);
    await shoot(`commands-list-${device}`);
    await input(page).fill("/gift ");
    await input(page).press("Enter");
    await expect(popup(page).getByRole("alert")).toBeVisible();
    await shoot(`commands-error-${device}`);
    await input(page).fill("/subinfo");
    await input(page).press("Escape");
    await input(page).press("Enter");
    await expect(popup(page).getByRole("status", { name: "Результат команды" })).toContainText("Строка результата 60");
    await shoot(`commands-long-result-${device}`);
  }
});
