import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, stubLog, test } from "./fixtures";

// The operator flow on the production build, against the stub of the project API (e2e/stub/api.mjs).
// Every test also fails on a CSP violation or a console error (fixtures.ts).
const CONSOLE = "/console/";
const list = (page: Page) => page.getByRole("listbox", { name: "Диалоги" });
const history = (page: Page) => page.getByRole("region", { name: "Переписка" });
const composer = (page: Page) => page.getByRole("textbox", { name: "Текст ответа" });
const project = (page: Page) => page.getByRole("button", { name: /^Текущий проект/ });

async function start(page: Page, context: BrowserContext, request: APIRequestContext, data: object = {}, path = CONSOLE) {
  await scenario(request, { me: "session", data });
  await context.addCookies([SESSION_COOKIE]);
  await page.goto(path);
  await expect(page.locator("#workspace")).toBeVisible();
}

async function openAnna(page: Page): Promise<void> {
  await list(page).getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(history(page).getByText("И ещё вопрос про оплату")).toBeVisible();
}

const control = (request: APIRequestContext, action: string, data: object) => request.post(`/__stub/${action}`, { data });

test.describe("operator flow", () => {
  test("the first available project loads; another one is picked from the menu with the keyboard", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await expect(project(page)).toHaveAccessibleName("Текущий проект Поддержка");
    await expect(page.locator(".project-logo")).toHaveAttribute("src", "/console/projects/p1/logo?v=logo-v1");
    await expect(list(page).getByRole("option")).toHaveText([/Анна Смирнова/, /Борис Петров/]);

    await project(page).focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu");
    // Only projects the account is a member of and that are active.
    await expect(menu.getByRole("menuitemradio")).toHaveText(["Поддержка", "Второй проект"]);
    await expect(menu.getByRole("menuitemradio", { name: "Поддержка" })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(menu).toBeHidden();
    await expect(project(page)).toBeFocused();
    await expect(project(page)).toHaveAccessibleName("Текущий проект Второй проект");
    await expect(list(page).getByRole("option")).toHaveText([/Григорий из второго/]);
    await expect(page.getByRole("heading", { name: "Выберите диалог" })).toBeVisible();

    await project(page).click();
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(project(page)).toBeFocused();
  });

  test("search, archive, folder tabs and the next page filter the list", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request, { many: true });
    await expect(list(page).getByRole("option")).toHaveCount(50);
    await page.getByRole("button", { name: "Показать ещё" }).click();
    await expect(list(page).getByRole("option")).toHaveCount(62);
    await expect(page.getByRole("button", { name: "Показать ещё" })).toBeHidden();

    await page.getByRole("searchbox", { name: "Поиск клиента" }).fill("борис");
    await expect(list(page).getByRole("option")).toHaveText([/Борис Петров/]);
    await page.getByRole("searchbox", { name: "Поиск клиента" }).fill("никого нет");
    await expect(page.getByText("Клиенты не найдены")).toBeVisible();
    await page.getByRole("searchbox", { name: "Поиск клиента" }).fill("");

    await page.getByRole("button", { name: "Открыть архив" }).click();
    await expect(page.getByRole("heading", { name: "Архив" })).toBeVisible();
    await expect(list(page).getByRole("option")).toHaveText([/Вера Архивная/]);
    await page.getByRole("button", { name: "К активным диалогам" }).click();
    await expect(page.getByRole("heading", { name: "Диалоги" })).toBeVisible();

    const tabs = page.getByRole("tablist", { name: "Папки диалогов" });
    await tabs.getByRole("tab", { name: "VIP" }).click();
    await expect(tabs.getByRole("tab", { name: "VIP" })).toHaveAttribute("aria-selected", "true");
    await expect(list(page).getByRole("option")).toHaveText([/Борис Петров/]);
    // Arrows move between tabs; the filter changes only on Enter or Space.
    await page.keyboard.press("ArrowLeft");
    await expect(tabs.getByRole("tab", { name: "Все" })).toBeFocused();
    await expect(tabs.getByRole("tab", { name: "VIP" })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(tabs.getByRole("tab", { name: "Все" })).toHaveAttribute("aria-selected", "true");
    await expect(list(page).getByRole("option")).toHaveCount(50);
  });

  test("the list moves with arrows and opens with Enter; history, older messages and the read mark", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await expect(list(page).getByRole("option", { name: /Анна Смирнова/ })).toContainText("2");
    await list(page).focus();
    await expect(list(page).getByRole("option", { name: /Анна Смирнова/ })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(list(page).getByRole("option", { name: /Борис Петров/ })).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: /Анна Смирнова/ })).toBeVisible();
    await expect(list(page).getByRole("option", { name: /Анна Смирнова/ })).toHaveAttribute("aria-selected", "true");
    await expect(history(page).getByText("И ещё вопрос про оплату")).toBeInViewport();
    // The newest fifty first; the rest arrive above without moving what the operator reads.
    await expect(history(page).locator("article")).toHaveCount(50);
    await expect(composer(page)).toBeFocused();
    // Reaching the top loads the older page (the button does the same); it lands above what was there.
    await expect(page.getByRole("button", { name: "Предыдущие сообщения" })).toBeVisible();
    await history(page).evaluate((element) => element.scrollTo({ top: 0 }));
    await expect(history(page).locator("article")).toHaveCount(64);
    await expect(page.getByRole("button", { name: "Предыдущие сообщения" })).toBeHidden();
    await expect(history(page).getByText("Сообщение 15", { exact: true })).toBeInViewport();
    await expect(history(page).getByText("Сообщение 1", { exact: true })).not.toBeInViewport();
    // The open, visible history was marked read up to its last message.
    await expect.poll(async () => (await stubLog(request)).some((entry) => /\/tickets\/t1\/read\//.test(entry.path))).toBe(true);
    await control(request, "incoming", { ticket: "t2", text: "Ещё одно сообщение" });
    await expect(list(page).getByRole("option", { name: /Борис Петров/ })).toContainText("Ещё одно сообщение");
    await expect(list(page).getByRole("option", { name: /Анна Смирнова/ }).locator(".count")).toHaveCount(0);
  });

  test("sending: Enter sends, Shift+Enter breaks the line, drafts stay with their dialogue, a file goes along", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await composer(page).fill("Первая строка");
    await composer(page).press("Shift+Enter");
    await composer(page).pressSequentially("Вторая строка");
    await composer(page).press("Enter");
    await expect(history(page).locator("article.outgoing").last()).toContainText("Первая строка\nВторая строка");
    await expect(composer(page)).toHaveValue("");
    await expect(composer(page)).toBeFocused();

    await composer(page).fill("черновик для Анны");
    await list(page).getByRole("option", { name: /Борис Петров/ }).click();
    await expect(composer(page)).toHaveValue("");
    await composer(page).fill("черновик для Бориса");
    await list(page).getByRole("option", { name: /Анна Смирнова/ }).click();
    await expect(composer(page)).toHaveValue("черновик для Анны");
    await list(page).getByRole("option", { name: /Борис Петров/ }).click();
    await expect(composer(page)).toHaveValue("черновик для Бориса");

    await page.locator('input[type="file"]').setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: Buffer.from("89504e47", "hex") });
    await expect(page.getByText("photo.png · 0.0 МБ")).toBeVisible();
    await page.getByRole("button", { name: "Отправить" }).click();
    await expect(page.getByText("photo.png · 0.0 МБ")).toBeHidden();
    await expect(history(page).locator("article.outgoing").last().getByRole("button", { name: "Открыть изображение" })).toBeVisible();
    await expect(history(page).locator("article.outgoing").last()).toContainText("черновик для Бориса");
  });

  test("quick replies: / lists them, arrows move, Enter inserts, Esc closes, focus stays in the text field", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await composer(page).pressSequentially("/");
    const replies = page.getByRole("listbox", { name: "Готовые ответы" });
    await expect(replies.getByRole("option")).toHaveCount(3);
    await expect(replies.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowDown");
    const second = replies.getByRole("option").nth(1);
    await expect(second).toHaveAttribute("aria-selected", "true");
    await expect(composer(page)).toHaveAttribute("aria-activedescendant", (await second.getAttribute("id"))!);
    await page.keyboard.press("Enter");
    await expect(replies).toBeHidden();
    await expect(composer(page)).toHaveValue("Спасибо за обращение, хорошего дня.");
    await expect(composer(page)).toBeFocused();

    await composer(page).fill("");
    await composer(page).pressSequentially("/нет такого");
    await expect(replies.getByText("Готовые ответы не найдены")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(replies).toBeHidden();
    await expect(composer(page)).toHaveValue("/нет такого");
  });

  test("live updates: a customer's message arrives through the event stream without a reload", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await expect.poll(async () => (await (await request.get("/__stub/streams?project=p1")).json() as { open: number }).open).toBe(1);
    await control(request, "incoming", { ticket: "t1", text: "Новое сообщение клиента" });
    await expect(history(page).getByText("Новое сообщение клиента")).toBeInViewport();
    await control(request, "incoming", { ticket: "t2", text: "Борис тоже пишет" });
    await expect(list(page).getByRole("option", { name: /Борис Петров/ })).toContainText("Борис тоже пишет");
    await expect(list(page).getByRole("option", { name: /Борис Петров/ }).locator(".count")).toHaveText(/2/);
  });

  test("closing and reopening a dialogue", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await page.getByRole("button", { name: "Завершить" }).click();
    await expect(page.getByText("В архиве")).toBeVisible();
    await expect(history(page).getByText("Обращение закрыто")).toBeVisible();
    await expect(list(page).getByRole("option", { name: /Анна Смирнова/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Открыть архив" }).click();
    await expect(list(page).getByRole("option", { name: /Анна Смирнова/ })).toBeVisible();
    await page.getByRole("button", { name: "Возобновить" }).click();
    await expect(page.getByRole("button", { name: "Завершить" })).toBeVisible();
    await expect(page.getByText("В архиве")).toBeHidden();
  });

  test("folders: create, rename, move a dialogue, delete after confirmation; Esc closes the top window only", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await page.getByRole("button", { name: "Управление общими папками" }).click();
    const folders = page.getByRole("dialog", { name: "Общие папки" });
    await folders.getByRole("textbox", { name: "Новая папка" }).fill("Срочные");
    await folders.getByRole("button", { name: "Создать" }).click();
    await expect(folders.getByRole("alert")).toHaveText("Изменения сохранены для всей команды.");
    await expect(folders.getByText("Срочные", { exact: true })).toBeVisible();
    await folders.getByRole("button", { name: "Переименовать папку VIP" }).click();
    await expect(folders.getByRole("textbox", { name: "Название папки" })).toBeFocused();
    await folders.getByRole("textbox", { name: "Название папки" }).fill("VIP клиенты");
    await folders.getByRole("button", { name: "Сохранить" }).click();
    await expect(folders.getByText("VIP клиенты", { exact: true })).toBeVisible();

    await folders.getByRole("button", { name: "Удалить папку Срочные" }).click();
    const confirm = page.getByRole("dialog", { name: "Удалить папку?" });
    await expect(confirm.getByRole("button", { name: "Отмена" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirm).toBeHidden();
    await expect(folders).toBeVisible();
    await folders.getByRole("button", { name: "Удалить папку Срочные" }).click();
    await confirm.getByRole("button", { name: "Удалить папку" }).click();
    await expect(confirm).toBeHidden();
    await expect(folders.getByText("Срочные", { exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(folders).toBeHidden();
    await expect(page.getByRole("button", { name: "Управление общими папками" })).toBeFocused();
    // The modal window hid the rest of the page from screen readers; now the tabs are back.
    await expect(page.getByRole("tab")).toHaveText(["Все", "VIP клиенты"]);

    await openAnna(page);
    await page.getByRole("button", { name: "Папка диалога Без папки" }).click();
    await page.getByRole("menuitemradio", { name: "VIP клиенты" }).click();
    await expect(page.getByRole("status")).toHaveText("Сохранено для команды");
    await expect(page.getByRole("button", { name: "Папка диалога VIP клиенты" })).toBeVisible();
    await page.getByRole("tab", { name: "VIP клиенты" }).click();
    await expect(list(page).getByRole("option")).toHaveText([/Анна Смирнова/, /Борис Петров/]);
  });

  test("the image viewer opens the original, zooms from the keyboard, Esc closes it and returns focus", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    const thumbnail = history(page).getByRole("button", { name: "Открыть изображение" });
    await thumbnail.click();
    const viewer = page.getByRole("dialog", { name: "Просмотр изображения" });
    await expect(viewer.getByRole("img", { name: "Изображение из переписки" })).toBeVisible();
    await page.keyboard.press("+");
    await expect(viewer.getByRole("button", { name: "150%" })).toBeVisible();
    await page.keyboard.press("0");
    await expect(viewer.getByRole("button", { name: "100%" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    await expect(thumbnail).toBeFocused();
    // The TGS sticker loads its player under the console CSP.
    await history(page).getByRole("button", { name: "Воспроизвести стикер" }).scrollIntoViewIfNeeded();
    await expect(history(page).locator(".sticker-preview canvas")).toBeAttached();
    await expect(history(page).getByRole("button", { name: "Воспроизвести стикер" })).not.toHaveAttribute("aria-disabled", "true");
  });

  test("the separator resizes the list from the keyboard, keeps the width after a reload, a double click resets it", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await page.setViewportSize({ width: 1440, height: 900 });
    await start(page, context, request);
    const sidebar = page.locator("#ticket-sidebar");
    const separator = page.getByRole("separator", { name: "Ширина списка диалогов" });
    const initial = (await sidebar.boundingBox())!.width;
    await separator.focus();
    for (let step = 0; step < 3; step++) await page.keyboard.press("ArrowRight");
    await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(Math.round(initial + 30));
    await expect(separator).toHaveAttribute("aria-valuenow", String(Math.round(initial + 30)));
    await page.reload();
    await expect(page.locator("#workspace")).toBeVisible();
    await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(Math.round(initial + 30));
    await separator.dblclick();
    await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(Math.round(initial));
    expect(await page.evaluate(() => localStorage.getItem("resolvate.sidebar-width"))).toBeNull();
  });

  test("phone: the list, then the dialogue, then back to the list at the same dialogue", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await page.setViewportSize({ width: 375, height: 812 });
    await start(page, context, request);
    await expect(list(page)).toBeVisible();
    await expect(page.getByRole("main")).toBeHidden();
    await openAnna(page);
    await expect(list(page)).toBeHidden();
    await expect(composer(page)).toBeVisible();
    await page.getByRole("button", { name: "К списку диалогов" }).click();
    await expect(list(page)).toBeVisible();
    await expect(page.getByRole("main")).toBeHidden();
    await expect(list(page).getByRole("option", { name: /Анна Смирнова/ })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });

  test("the workspace follows the dark, light and system themes", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    for (const [preference, scheme, background] of [
      ["dark", "light", "rgb(26, 29, 34)"],
      ["light", "dark", "rgb(246, 247, 250)"],
      [null, "dark", "rgb(26, 29, 34)"],
    ] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.addInitScript((value) => {
        if (value) localStorage.setItem("resolvate.theme", value);
        else localStorage.removeItem("resolvate.theme");
      }, preference);
      await start(page, context, request);
      await openAnna(page);
      await expect(history(page)).toHaveCSS("background-color", background);
    }
  });

  test("a revoked project leaves no project selected and says why", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await expect.poll(async () => (await (await request.get("/__stub/streams?project=p1")).json() as { open: number }).open).toBe(1);
    await control(request, "revoke", { project: "p1", status: 403 });
    await expect(page.getByRole("alert")).toHaveText("Доступ к проекту изменился. Выберите доступный проект.");
    await expect(project(page)).toHaveAccessibleName("Текущий проект Выберите проект");
    await expect(page.getByRole("heading", { name: "Нет активного проекта" })).toBeVisible();
  });

  test("a ?project=&ticket= link opens that dialogue; a link to an unavailable project says so", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request, {}, `${CONSOLE}?project=p1&ticket=t2`);
    await expect(page.getByRole("button", { name: /Борис Петров/ })).toBeVisible();
    await expect(history(page).getByText("Здравствуйте, нужна помощь")).toBeVisible();
    await page.goto(`${CONSOLE}?project=p4&ticket=t4`);
    await expect(page.getByRole("alert")).toHaveText("Нет доступа к проекту из ссылки.");
  });
});
