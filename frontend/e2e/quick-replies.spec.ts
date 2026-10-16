import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, stubLog, test } from "./fixtures";

// The quick replies picker in the composer (components/composer/Composer.vue, QuickReplies.vue): one
// picker with its own search, opened by "/" typed into an empty reply box or by the button. The search
// never changes the draft; a reply goes where the cursor (or the selection) was. Real focus, keys,
// scrolling and layout; every test also fails on a CSP violation or a console error.
const composer = (page: Page) => page.getByRole("textbox", { name: "Текст ответа" });
const button = (page: Page) => page.locator(".composer").getByRole("button", { name: "Готовые ответы" });
const search = (page: Page) => page.getByRole("combobox", { name: "Поиск готовых ответов" });
const groups = (page: Page) => page.getByRole("listbox", { name: "Группы ответов" });
const replies = (page: Page) => page.getByRole("listbox", { name: "Готовые ответы" });
const popup = (page: Page) => page.locator(".reply-options");
const results = (page: Page) => popup(page).locator(".reply-options-body");
const LONG_URL = `https://example.com/${"a1b2c3d4e5".repeat(30)}?utm=${"x".repeat(80)}`;

async function start(page: Page, context: BrowserContext, request: APIRequestContext, data: object = {}): Promise<void> {
  await scenario(request, { me: "session", data });
  await context.addCookies([SESSION_COOKIE]);
  await page.goto("/console/");
  await page.getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(composer(page)).toBeEditable();
}

const cursor = (page: Page) => composer(page).evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd]);
const sends = async (request: APIRequestContext) => (await stubLog(request)).filter((entry) => entry.path.endsWith("/send")).length;

test.describe("one picker, two ways in", () => {
  test("\"/\" in an empty reply box: the search takes the focus and the next keys, the draft stays empty; Esc gives the focus back to the box", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await composer(page).pressSequentially("/опл");
    await expect(search(page)).toBeFocused();
    await expect(search(page)).toHaveValue("опл");
    await expect(groups(page).getByRole("option")).toHaveText(["/оплата"]);
    await expect(composer(page)).toHaveValue("");
    await expect(search(page)).toHaveAttribute("aria-controls", (await groups(page).getAttribute("id"))!);
    await expect(search(page)).toHaveAttribute("aria-activedescendant", (await groups(page).getByRole("option").first().getAttribute("id"))!);
    await expect(composer(page)).not.toHaveAttribute("aria-activedescendant");
    // Backspace edits the search, also an empty one: nothing closes.
    for (let index = 0; index < 4; index++) await page.keyboard.press("Backspace");
    await expect(search(page)).toHaveValue("");
    await expect(groups(page).getByRole("option")).toHaveCount(2);
    await expect(search(page)).toBeFocused();
    await page.keyboard.type("нет такого");
    await expect(page.getByText("Ничего не найдено")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popup(page)).toBeHidden();
    await expect(composer(page)).toBeFocused();
    await expect(composer(page)).toHaveValue("");
  });

  test("the button opens the same picker and leaves the draft; Esc gives the focus back to the button", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await composer(page).fill("Черновик оператора");
    // An icon on the button; "/" is the keyboard's way in.
    await expect(button(page).locator("svg.icon")).toBeVisible();
    await expect(button(page).locator('span[aria-hidden="true"]')).toHaveCount(0);
    await expect(button(page)).toHaveAttribute("aria-keyshortcuts", "/");
    await button(page).click();
    await expect(search(page)).toBeFocused();
    await expect(search(page)).toHaveAttribute("placeholder", "Найти группу…");
    await expect(popup(page).locator(".reply-options-head")).toHaveText(/Группы ответов/);
    await expect(composer(page)).toHaveValue("Черновик оператора");
    await expect(button(page)).toHaveAttribute("aria-expanded", "true");
    await expect(groups(page).getByRole("option")).toHaveCount(2);
    await page.keyboard.type("опл");
    await expect(groups(page).getByRole("option")).toHaveText(["/оплата"]);
    await expect(composer(page)).toHaveValue("Черновик оператора");
    await page.keyboard.press("Escape");
    await expect(popup(page)).toBeHidden();
    await expect(button(page)).toBeFocused();
    await expect(button(page)).toHaveAttribute("aria-expanded", "false");
    await expect(composer(page)).toHaveValue("Черновик оператора");
  });

  test("a \"/\" inside text, a URL or a path is text; a reply box with text opens nothing", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await composer(page).pressSequentially("См. https://example.com/a/b и /etc/hosts");
    await expect(composer(page)).toHaveValue("См. https://example.com/a/b и /etc/hosts");
    await expect(popup(page)).toBeHidden();
    await composer(page).fill(" ");
    await composer(page).press("End");
    await page.keyboard.type("/");
    await expect(composer(page)).toHaveValue(" /");
    await expect(popup(page)).toBeHidden();
  });

  test("into a group and back with arrows and Enter; a reply into the empty box becomes its text, nothing is sent", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    const before = await sends(request);
    await composer(page).pressSequentially("/");
    await expect(groups(page).getByRole("option")).toHaveCount(2);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(replies(page).getByRole("option")).toHaveCount(1);
    await expect(search(page)).toBeFocused();
    await expect(search(page)).toHaveValue("");
    await expect(search(page)).toHaveAttribute("placeholder", "Найти ответ…");
    await expect(composer(page)).toHaveValue("");
    await page.getByRole("button", { name: "← Группы" }).click();
    await expect(groups(page).getByRole("option")).toHaveCount(2);
    await expect(search(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(replies(page).getByRole("option")).toHaveCount(2);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(popup(page)).toBeHidden();
    await expect(composer(page)).toHaveValue("Спасибо за обращение, хорошего дня.");
    await expect(composer(page)).toBeFocused();
    expect(await cursor(page)).toEqual([35, 35]);
    expect(await sends(request)).toBe(before);
  });

  test("a reply goes where the cursor was or over the selection, the cursor after it; the draft's file stays", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await page.locator('input[type="file"]').setInputFiles({ name: "terms.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1") });
    await composer(page).fill("Здравствуйте. До свидания.");
    await composer(page).evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(14, 14));
    await button(page).click();
    await page.keyboard.type("опл");
    await expect(groups(page).getByRole("option")).toHaveText(["/оплата"]);
    await page.keyboard.press("Enter");
    await expect(replies(page).getByRole("option")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(composer(page)).toHaveValue("Здравствуйте. Проверьте, пожалуйста, настройки тарифа.До свидания.");
    await expect(composer(page)).toBeFocused();
    expect(await cursor(page)).toEqual(Array(2).fill("Здравствуйте. Проверьте, пожалуйста, настройки тарифа.".length));
    // A selection is replaced.
    await composer(page).evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 13));
    await button(page).click();
    await expect(groups(page).getByRole("option")).toHaveCount(2);
    await page.keyboard.press("Enter");
    await expect(replies(page).getByRole("option")).toHaveCount(2);
    await page.keyboard.press("Enter");
    await expect(composer(page)).toHaveValue("Здравствуйте! Чем могу помочь? Проверьте, пожалуйста, настройки тарифа.До свидания.");
    expect(await cursor(page)).toEqual([30, 30]);
    await expect(page.getByRole("group", { name: "Выбранные вложения" })).toContainText("terms.pdf");
  });

  test("Esc closes it from a button inside the list too, wherever it was opened from", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await button(page).click();
    await expect(groups(page).getByRole("option")).toHaveCount(2);
    await page.keyboard.press("Enter");
    await expect(replies(page).getByRole("option")).toHaveCount(2);
    await page.getByRole("button", { name: "← Группы" }).focus();
    await page.keyboard.press("Escape");
    await expect(popup(page)).toBeHidden();
    await expect(button(page)).toBeFocused();
    await composer(page).focus();
    await page.keyboard.type("/");
    await page.getByRole("button", { name: "Закрыть готовые ответы" }).focus();
    await page.keyboard.press("Escape");
    await expect(popup(page)).toBeHidden();
    await expect(composer(page)).toBeFocused();
    await expect(composer(page)).toHaveValue("");
  });
});

test.describe("failures and layout", () => {
  test("a failed lookup is not \"nothing found\": it says so, and the retry finds the groups", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await page.route("**/console/projects/p1/reply-groups?*", (route) => route.fulfill({ status: 503, json: { detail: "Сервис недоступен." } }), { times: 1 });
    await composer(page).pressSequentially("/");
    await expect(popup(page).getByRole("alert")).toHaveText(/Не удалось загрузить готовые ответы\./);
    await expect(page.getByText("Ничего не найдено")).toBeHidden();
    await expect(search(page)).toBeFocused();
    // Enter while it failed sends nothing from the reply box.
    await page.keyboard.press("Enter");
    await expect(popup(page)).toBeVisible();
    await popup(page).getByRole("button", { name: "Повторить" }).click();
    await expect(groups(page).getByRole("option")).toHaveCount(2);
    await expect(popup(page).getByRole("alert")).toBeHidden();
    await expect(composer(page)).toHaveValue("");
  });

  for (const width of [1280, 375]) {
    test(`a long URL wraps inside the list at ${width}px; the list keeps to the chat (and a readable width) and the screen`, async ({ page, context, request, consoleErrors }) => {
      void consoleErrors;
      await page.setViewportSize({ width, height: 800 });
      await start(page, context, request);
      await page.route("**/console/projects/p1/replies?*", (route) => route.fulfill({ json: [{ id: "9", text: `Ссылка: ${LONG_URL}`, group_id: "g1", revision: 0 }] }));
      await button(page).click();
      await expect(groups(page).getByRole("option")).toHaveCount(2);
      await page.keyboard.press("Enter");
      const option = replies(page).getByRole("option");
      await expect(option).toContainText("https://example.com/");
      const box = (await popup(page).boundingBox())!;
      const chat = (await page.locator(".composer-area").boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(chat.x);
      expect(box.x + box.width).toBeLessThanOrEqual(chat.x + chat.width + 0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      if (width === 1280) expect(box.width).toBeLessThanOrEqual(640.5);
      // Nothing scrolls sideways: the option, the list or the page.
      expect(await option.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      expect(await results(page).evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      // The search field's focus ring (3 px, 3 px off) is not cut off at the sides.
      const field = (await search(page).boundingBox())!;
      expect(field.x - 6).toBeGreaterThanOrEqual(box.x);
      expect(field.x + field.width + 6).toBeLessThanOrEqual(box.x + box.width);
    });
  }

  for (const width of [1280, 375]) {
    test(`scrolled results fade at their top edge, clear of the search's focus ring, at ${width}px`, async ({ page, context, request, consoleErrors, attachScreenshot, browserName }, testInfo) => {
      void consoleErrors;
      await page.setViewportSize({ width, height: 800 });
      // Fifty groups and more: the results scroll under a still header and search.
      await start(page, context, request, { catalog: "large" });
      await composer(page).pressSequentially("/");
      await expect(groups(page).getByRole("option")).toHaveCount(50);
      await expect(search(page)).toBeFocused();
      const head = (await popup(page).locator(".reply-options-head").boundingBox())!;
      const field = (await search(page).boundingBox())!;
      const list = (await results(page).boundingBox())!;
      // The search's focus ring (3 px, 3 px off the field) ends above the scrolling results: no layer overlaps it.
      expect(field.y + field.height + 6).toBeLessThanOrEqual(list.y);
      await expect(results(page)).not.toHaveAttribute("data-scrolled");
      await expect(results(page)).toHaveCSS("mask-image", "none");
      await results(page).hover();
      // Part way into an option: its top line is under the fade.
      await page.mouse.wheel(0, 262);
      await expect(results(page)).toHaveAttribute("data-scrolled");
      await expect(results(page)).toHaveCSS("mask-image", /linear-gradient/);
      expect(await popup(page).locator(".reply-options-head").boundingBox()).toEqual(head);
      expect(await search(page).boundingBox()).toEqual(field);
      for (const theme of ["light", "dark"]) {
        await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
        await attachScreenshot(`scroll-fade-${width}-${theme}`);
        if (browserName === "chromium") await page.screenshot({ path: testInfo.outputPath(`scroll-fade-${width}-${theme}.png`) });
      }
      // Back at the start, the fade goes.
      await page.mouse.wheel(0, -2000);
      await expect(results(page)).not.toHaveAttribute("data-scrolled");
      // The pointer leaves the list: an option under it would follow the pointer, not the arrows.
      await page.mouse.move(0, 0);
      // An option reached with the arrows is all in view, below the fade, whichever way the list moved.
      const options = groups(page).getByRole("option");
      const selected = () => options.evaluateAll((items) => items.findIndex((item) => item.getAttribute("aria-selected") === "true"));
      async function select(index: number): Promise<void> {
        for (let at = await selected(); at !== index; at += at < index ? 1 : -1) await page.keyboard.press(at < index ? "ArrowDown" : "ArrowUp");
        await expect(options.nth(index)).toHaveAttribute("aria-selected", "true");
      }
      const fullyShown = async () => {
        const option = (await groups(page).locator('[aria-selected="true"]').boundingBox())!;
        const view = (await results(page).boundingBox())!;
        return option.y >= view.y + 14 - 0.5 && option.y + option.height <= view.y + view.height + 0.5;
      };
      await select(12);
      await expect(results(page)).toHaveAttribute("data-scrolled");
      await expect.poll(fullyShown).toBe(true);
      await select(3);
      await expect.poll(fullyShown).toBe(true);
      // The first option brings the list back to its start, with no fade; round to the last and back again.
      await select(0);
      await expect(results(page)).not.toHaveAttribute("data-scrolled");
      await page.keyboard.press("ArrowUp");
      await expect(options.last()).toHaveAttribute("aria-selected", "true");
      await expect.poll(fullyShown).toBe(true);
      await page.keyboard.press("ArrowDown");
      await expect(options.first()).toHaveAttribute("aria-selected", "true");
      await expect(results(page)).not.toHaveAttribute("data-scrolled");
    });
  }

  test("a list with nothing to scroll has no fade", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await composer(page).pressSequentially("/");
    await expect(groups(page).getByRole("option")).toHaveCount(2);
    expect(await results(page).evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
    await results(page).hover();
    await page.mouse.wheel(0, 240);
    await expect(results(page)).not.toHaveAttribute("data-scrolled");
    await expect(results(page)).toHaveCSS("mask-image", "none");
  });

  test.describe("forced colors", () => {
    // Skipped before the test's fixtures start: a page never opened has no CSP probe to check.
    test.skip(({ browserName }) => browserName !== "chromium", "Forced colors are emulated in Chromium.");

    test("forced colors keep the scrolled results whole: no fade", async ({ page, context, request, consoleErrors }) => {
      void consoleErrors;
      await page.emulateMedia({ forcedColors: "active" });
      await start(page, context, request, { catalog: "large" });
      await composer(page).pressSequentially("/");
      await expect(groups(page).getByRole("option")).toHaveCount(50);
      await results(page).hover();
      await page.mouse.wheel(0, 240);
      await expect(results(page)).toHaveAttribute("data-scrolled");
      await expect(results(page)).toHaveCSS("mask-image", "none");
    });
  });
});
