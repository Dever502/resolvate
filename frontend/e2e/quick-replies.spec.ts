import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, test } from "./fixtures";

// The quick replies list in the composer (components/composer/Composer.vue, QuickReplies.vue), in its
// two ways of opening: "/" typed at the start of the reply box (the box keeps the focus and searches)
// and the "/" button (a search field of its own takes the focus). Real focus, keys and layout.
const composer = (page: Page) => page.getByRole("textbox", { name: "Текст ответа" });
const button = (page: Page) => page.locator(".composer").getByRole("button", { name: "Готовые ответы" });
const search = (page: Page) => page.getByRole("combobox", { name: "Поиск готовых ответов" });
const groups = (page: Page) => page.getByRole("listbox", { name: "Группы ответов" });
const replies = (page: Page) => page.getByRole("listbox", { name: "Готовые ответы" });
const popup = (page: Page) => page.locator(".reply-options");
const LONG_URL = `https://example.com/${"a1b2c3d4e5".repeat(30)}?utm=${"x".repeat(80)}`;

async function start(page: Page, context: BrowserContext, request: APIRequestContext): Promise<void> {
  await scenario(request, { me: "session" });
  await context.addCookies([SESSION_COOKIE]);
  await page.goto("/console/");
  await page.getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(composer(page)).toBeEditable();
}

test.describe("typed /", () => {
  test("the reply box keeps the focus; Backspace on the / closes the list; Esc closes it and leaves the text", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await composer(page).pressSequentially("/опл");
    await expect(groups(page).getByRole("option")).toHaveText(["/оплата"]);
    await expect(composer(page)).toBeFocused();
    await expect(composer(page)).toHaveAttribute("aria-controls", (await groups(page).getAttribute("id"))!);
    await expect(composer(page)).toHaveAttribute("aria-activedescendant", (await groups(page).getByRole("option").first().getAttribute("id"))!);
    for (let index = 0; index < 3; index++) await page.keyboard.press("Backspace");
    await expect(composer(page)).toHaveValue("/");
    await expect(groups(page)).toBeVisible();
    await page.keyboard.press("Backspace");
    await expect(popup(page)).toBeHidden();
    await expect(composer(page)).not.toHaveAttribute("aria-activedescendant");
    await composer(page).pressSequentially("/нет такого");
    await expect(page.getByText("Ничего не найдено")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popup(page)).toBeHidden();
    await expect(composer(page)).toBeFocused();
    await expect(composer(page)).toHaveValue("/нет такого");
  });

  test("into a group and back, arrows and Enter: the reply takes the place of the typed command", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await composer(page).pressSequentially("/");
    await expect(groups(page).getByRole("option")).toHaveCount(2);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(composer(page)).toHaveValue("/оплата ");
    await expect(replies(page).getByRole("option")).toHaveCount(1);
    await page.getByRole("button", { name: "← Группы" }).click();
    await expect(composer(page)).toHaveValue("/");
    await expect(composer(page)).toBeFocused();
    await expect(groups(page).getByRole("option")).toHaveCount(2);
    await page.keyboard.press("Enter");
    await expect(replies(page).getByRole("option")).toHaveCount(2);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(composer(page)).toHaveValue("Спасибо за обращение, хорошего дня.");
    await expect(popup(page)).toBeHidden();
  });
});

test.describe("the / button", () => {
  test("opens a search of its own and leaves the draft; Backspace in an empty search closes nothing; Esc gives the focus back to the button", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await composer(page).fill("Черновик оператора");
    await button(page).click();
    await expect(search(page)).toBeFocused();
    await expect(composer(page)).toHaveValue("Черновик оператора");
    await expect(button(page)).toHaveAttribute("aria-expanded", "true");
    // The search field, which has the focus, points at the options; the reply box does not.
    await expect(groups(page).getByRole("option")).toHaveCount(2);
    await expect(search(page)).toHaveAttribute("aria-controls", (await groups(page).getAttribute("id"))!);
    await expect(search(page)).toHaveAttribute("aria-activedescendant", (await groups(page).getByRole("option").first().getAttribute("id"))!);
    await expect(composer(page)).not.toHaveAttribute("aria-activedescendant");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await expect(search(page)).toBeFocused();
    await page.keyboard.type("опл");
    await expect(groups(page).getByRole("option")).toHaveText(["/оплата"]);
    await page.keyboard.press("Backspace");
    await expect(search(page)).toHaveValue("оп");
    await page.keyboard.press("Escape");
    await expect(popup(page)).toBeHidden();
    await expect(button(page)).toBeFocused();
    await expect(button(page)).toHaveAttribute("aria-expanded", "false");
    await expect(composer(page)).toHaveValue("Черновик оператора");
  });

  test("Esc closes it from a button inside the list too", async ({ page, context, request, consoleErrors }) => {
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
    await button(page).click();
    await page.getByRole("button", { name: "Закрыть готовые ответы" }).focus();
    await page.keyboard.press("Escape");
    await expect(popup(page)).toBeHidden();
    await expect(button(page)).toBeFocused();
  });

  test("a reply goes where the cursor was, the rest of the draft stays, the cursor follows the reply", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
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
    expect(await composer(page).evaluate((element: HTMLTextAreaElement) => element.selectionStart))
      .toBe("Здравствуйте. Проверьте, пожалуйста, настройки тарифа.".length);
  });
});

test.describe("failures and layout", () => {
  test("a failed lookup is not \"nothing found\": it says so, and the retry finds the groups", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await page.route("**/console/projects/p1/reply-groups?*", (route) => route.fulfill({ status: 503, json: { detail: "Сервис недоступен." } }), { times: 1 });
    await button(page).click();
    await expect(popup(page).getByRole("alert")).toHaveText(/Не удалось загрузить готовые ответы\./);
    await expect(page.getByText("Ничего не найдено")).toBeHidden();
    await expect(search(page)).toBeFocused();
    // Enter while it failed sends nothing from the reply box.
    await page.keyboard.press("Enter");
    await expect(popup(page)).toBeVisible();
    await popup(page).getByRole("button", { name: "Повторить" }).click();
    await expect(groups(page).getByRole("option")).toHaveCount(2);
    await expect(popup(page).getByRole("alert")).toBeHidden();
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
      expect(await popup(page).locator(".reply-options-body").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      // The search field's focus ring is not cut off.
      const field = (await search(page).boundingBox())!;
      expect(field.x - 6).toBeGreaterThanOrEqual(box.x);
      expect(field.x + field.width + 6).toBeLessThanOrEqual(box.x + box.width);
    });
  }
});
