import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, stubLog, test } from "./fixtures";

// An operator's internal note (chat/MessageItem.vue) is a labelled card of its own in the history: said in words with
// its author and time, not the team's reply bubble on the right, in its place in time; the dialogue's row names it
// instead of showing its text. The stub serves notes as the server does (author resolved, direction "to the user").
// Every test also fails on a CSP violation or a console error.
const LONG = "Клиент оплатил вчера, ждёт продления. Чек: https://pay.example.com/receipts/2026-10-25/very-long-receipt-identifier-0123456789abcdef — не закрывать до ответа бухгалтерии.";

const history = (page: Page) => page.getByRole("region", { name: "Переписка" });
const list = (page: Page) => page.getByRole("listbox", { name: "Диалоги" });
const input = (page: Page) => page.getByRole("textbox", { name: "Текст ответа" });
const notes = (page: Page) => history(page).getByRole("article").filter({ hasText: "Внутренняя заметка" });

async function note(request: APIRequestContext, text: string, author: string, minutesAgo = 0): Promise<void> {
  const time = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  await request.post("/__stub/note", { data: { ticket: "t1", text, author, time } });
}

async function start(page: Page, context: BrowserContext, request: APIRequestContext, width = 1280, height = 800): Promise<void> {
  await page.setViewportSize({ width, height });
  await scenario(request, { me: "session" });
  await context.addCookies([SESSION_COOKIE]);
  // One note between the customer's two messages, one after them.
  await note(request, "Звонила вчера, просила не беспокоить до обеда.", "Пётр", 4.5);
  await note(request, LONG, "Ирина Соколова");
  await page.goto("/console/");
  await list(page).getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(input(page)).toBeEditable();
}

test("a note says what it is, who wrote it and when, in its place in time, and is not a reply to the customer", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await start(page, context, request);
  // A reply of the team, for comparison.
  await input(page).fill("Сейчас проверю оплату");
  await input(page).press("Enter");
  const reply = history(page).getByRole("article").filter({ hasText: "Сейчас проверю оплату" });
  await expect(reply).toBeVisible();

  await expect(notes(page)).toHaveCount(2);
  const latest = notes(page).filter({ hasText: "Ирина Соколова" });
  await expect(latest).toContainText("Внутренняя заметка");
  await expect(latest).toContainText("Ирина Соколова");
  await expect(latest.locator("time")).toHaveAttribute("datetime", /T/);
  await expect(latest).toContainText(LONG);

  // In time: the earlier note between the customer's two messages.
  const texts = await history(page).getByRole("article").allInnerTexts();
  const position = (part: string) => texts.findIndex((text) => text.includes(part));
  expect(position("Как подключить тариф?")).toBeLessThan(position("просила не беспокоить"));
  expect(position("просила не беспокоить")).toBeLessThan(position("И ещё вопрос про оплату"));
  expect(position("И ещё вопрос про оплату")).toBeLessThan(position("Ирина Соколова"));

  // Not the reply's form: no bubble, not on the right edge with the replies, a line on its start edge.
  const view = (await history(page).boundingBox())!;
  const noteBox = (await latest.boundingBox())!;
  const replyBox = (await reply.boundingBox())!;
  expect(await latest.locator(".bubble").count()).toBe(0);
  expect(noteBox.x + noteBox.width).toBeLessThan(replyBox.x + replyBox.width - 24);
  expect(Math.abs(noteBox.x + noteBox.width / 2 - (view.x + view.width / 2))).toBeLessThan(24);
  const card = await latest.locator(".note-card").evaluate((element) => {
    const css = getComputedStyle(element);
    return { start: css.borderLeftWidth, startStyle: css.borderLeftStyle, radius: css.borderTopRightRadius };
  });
  expect(card).toEqual({ start: "3px", startStyle: "solid", radius: "8px" });
  // The whole text wraps inside the card, the link too.
  expect(await latest.locator(".note-text").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  // The dialogue's row names the latest activity, never shows the note's text.
  await input(page).fill("");
  await note(request, "Секретный контекст команды", "Ирина Соколова");
  const row = list(page).getByRole("option", { name: /Анна Смирнова/ });
  await expect(row).toContainText("Внутренняя заметка");
  await expect(row).not.toContainText("Секретный контекст");
  // A note never goes to the customer: nothing but the reply was sent.
  expect((await stubLog(request)).filter((entry) => entry.path.endsWith("/send"))).toHaveLength(1);
});

test("a note coming in at the end keeps the operator at the end", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await start(page, context, request);
  const fromEnd = () => history(page).evaluate((element) => Math.round(element.scrollHeight - element.scrollTop - element.clientHeight));
  await expect.poll(fromEnd).toBeLessThanOrEqual(1);
  await note(request, "Новая заметка в конце истории", "Пётр");
  await expect(notes(page).filter({ hasText: "Новая заметка в конце" })).toBeVisible();
  await expect.poll(fromEnd).toBeLessThanOrEqual(1);
});

for (const width of [375, 320]) {
  test(`at ${width} px a note keeps to the screen and its text wraps`, async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request, width, 740);
    const latest = notes(page).filter({ hasText: "Ирина Соколова" });
    await expect(latest).toBeVisible();
    const box = (await latest.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await latest.locator(".note-text").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
}

test.describe("forced colors", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "forced colors are emulated in Chromium only");

  test("a note keeps its border, its edge and its label", async ({ page, context, request, consoleErrors, attachScreenshot }) => {
    void consoleErrors;
    await page.emulateMedia({ forcedColors: "active" });
    await start(page, context, request);
    const latest = notes(page).filter({ hasText: "Ирина Соколова" });
    await expect(latest).toContainText("Внутренняя заметка");
    const card = await latest.locator(".note-card").evaluate((element) => {
      const css = getComputedStyle(element);
      return { top: css.borderTopStyle, start: css.borderLeftWidth };
    });
    expect(card).toEqual({ top: "solid", start: "3px" });
    await attachScreenshot("note-forced-colors");
  });
});

test("screenshots: a dialogue with notes, desktop and phone, light and dark", async ({ page, context, request, consoleErrors, attachScreenshot, browserName }, testInfo) => {
  void consoleErrors;
  await page.emulateMedia({ reducedMotion: "reduce" });
  const shoot = async (name: string) => {
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await attachScreenshot(`${name}-${theme}`);
      if (browserName === "chromium") await page.screenshot({ path: testInfo.outputPath(`${name}-${theme}.png`) });
    }
  };
  await start(page, context, request);
  await input(page).fill("Сейчас проверю оплату");
  await input(page).press("Enter");
  await expect(history(page).getByText("Сейчас проверю оплату")).toBeVisible();
  await note(request, "Проверила: платёж прошёл, продлеваю вручную.", "Пётр");
  await expect(notes(page).filter({ hasText: "продлеваю вручную" })).toBeVisible();
  await shoot("notes-desktop");
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 740 });
    await expect(notes(page).last()).toBeInViewport();
    await shoot(`notes-phone-${width}`);
  }
  if (browserName === "chromium") {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await page.emulateMedia({ forcedColors: "active" });
    await page.screenshot({ path: testInfo.outputPath("notes-forced-colors.png") });
  }
});
