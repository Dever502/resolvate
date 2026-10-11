import { createHash } from "node:crypto";
import type { APIRequestContext, BrowserContext, Locator, Page } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, stubLog, test } from "./fixtures";

// A 1×1 PNG: decodes in every browser and passes the stub's check of the image bytes.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

// Administration on the production build: projects, members, connections and staff, against the
// stub whose installation routes (e2e/stub/admin.mjs) keep the backend's rights, rules and answers.
// Every test also fails on a CSP violation or a console error (fixtures.ts).
async function start(page: Page, context: BrowserContext, request: APIRequestContext, data: object = {}) {
  await scenario(request, { me: "session", data });
  await context.addCookies([SESSION_COOKIE]);
  await page.goto("/console/");
  await expect(page.locator("#workspace")).toBeVisible();
}

const adminMenu = (page: Page) => page.getByRole("button", { name: "Управление", exact: true });

async function openWindow(page: Page, item: "Проекты" | "Сотрудники"): Promise<Locator> {
  await adminMenu(page).click();
  await page.getByRole("menuitem", { name: item }).click();
  const dialog = page.getByRole("dialog", { name: item });
  await expect(dialog).toBeVisible();
  return dialog;
}

const row = (scope: Locator, list: string, text: string) =>
  scope.getByRole("list", { name: list }).getByRole("listitem").filter({ hasText: text });

async function manage(page: Page, name: string): Promise<Locator> {
  const dialog = await openWindow(page, "Проекты");
  await row(dialog, "Проекты", name).getByRole("button", { name: `Настроить проект ${name}` }).click();
  const screen = page.getByRole("dialog", { name });
  // The list's button is gone: focus starts at the way back.
  await expect(screen.getByRole("button", { name: "Все проекты" })).toBeFocused();
  return screen;
}

const leaveIsGuarded = (page: Page) => page.evaluate(() => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
});

test.describe("first launch and access", () => {
  test("the installation administrator creates, configures and switches on the first project", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request, { account: "admin", noProjects: true });
    await expect(page.getByRole("heading", { name: "Создайте первый проект" })).toBeVisible();
    await page.getByRole("button", { name: "Создать проект" }).click();
    const dialog = page.getByRole("dialog", { name: "Проекты" });
    await expect(dialog.getByText("Проектов пока нет. Создайте первый проект.")).toBeVisible();
    // The form is open, the account itself is the default administrator.
    await expect(dialog.getByRole("combobox", { name: "Администратор проекта" })).toHaveValue("Администратор Установки · admin");
    await dialog.getByRole("button", { name: "Создать проект" }).click();
    await expect(dialog.getByText("Укажите название проекта.")).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Название" })).toBeFocused();
    await dialog.getByRole("textbox", { name: "Название" }).fill("Новый проект");
    await dialog.getByRole("button", { name: "Создать проект" }).click();
    await expect(dialog.getByText(/^Проект «Новый проект» создан выключенным/)).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Название" })).toHaveValue("");
    const created = row(dialog, "Проекты", "Новый проект");
    await expect(created).toContainText("Выключен");
    await expect(created).toContainText("Вы — администратор проекта");

    // Switching on is refused until the bot and the group are saved; the server says why.
    await created.getByRole("button", { name: "Включить проект Новый проект" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Администратор проекта должен сначала настроить бота и группу.");

    await created.getByRole("button", { name: "Настроить проект Новый проект" }).click();
    const screen = page.getByRole("dialog", { name: "Новый проект" });
    await screen.getByRole("tab", { name: "Подключения" }).click();
    const token = screen.getByLabel("Токен бота");
    const group = screen.getByRole("textbox", { name: "ID группы поддержки" });
    await expect(token).toHaveAttribute("placeholder", "Не настроено");
    await expect(group).not.toHaveAttribute("inputmode", /.+/);
    await token.fill("not-a-token");
    await group.fill("123");
    await screen.getByRole("button", { name: "Сохранить подключения" }).click();
    await expect(screen.getByText("Неверный формат токена: номер бота, двоеточие и ключ от 20 символов.")).toBeVisible();
    await expect(screen.getByText("Нужен отрицательный ID супергруппы, например -1001234567890.")).toBeVisible();
    await expect(token).toBeFocused();
    await expect(token).toHaveAttribute("aria-invalid", "true");
    await token.fill("123456789:AAAAAAAAAAAAAAAAAAAAAAAA");
    await group.fill("-1001234567890");
    await screen.getByRole("button", { name: "Сохранить подключения" }).click();
    await expect(screen.getByText("Подключения сохранены. Активный проект перезапустится автоматически.")).toBeVisible();
    await expect(token).toHaveValue("");
    await expect(token).toHaveAttribute("placeholder", "Ключ сохранён");
    await expect(group).toHaveValue("-1001234567890");

    await screen.getByRole("button", { name: "Все проекты" }).click();
    const list = page.getByRole("dialog", { name: "Проекты" });
    await row(list, "Проекты", "Новый проект").getByRole("button", { name: "Включить проект Новый проект" }).click();
    await expect(list.getByText("Проект «Новый проект» включён.")).toBeVisible();
    await expect(row(list, "Проекты", "Новый проект")).toContainText("Включён");
    await row(list, "Проекты", "Новый проект").getByRole("button", { name: "Открыть проект Новый проект" }).click();
    await expect(list).toBeHidden();
    await expect(page.getByRole("button", { name: "Текущий проект Новый проект" })).toBeVisible();
    await expect(page.getByText("Здесь пока нет диалогов")).toBeVisible();
  });

  test("projects without own access: the installation administrator grants it and opens the project", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request, { account: "admin", handover: true });
    await expect(page.getByRole("heading", { name: "Нет доступа к переписке" })).toBeVisible();
    await page.getByRole("button", { name: "Открыть проекты" }).click();
    const dialog = page.getByRole("dialog", { name: "Проекты" });
    const support = row(dialog, "Проекты", "Поддержка");
    await expect(support).toContainText("Доступ к переписке не выдан");
    await expect(support).toContainText("администратор: Ирина Соколова");
    await expect(support.getByRole("button", { name: /^Открыть/ })).toHaveCount(0);
    await support.getByRole("button", { name: "Выдать себе доступ к проекту Поддержка" }).click();
    await expect(dialog.getByText("Вы получили доступ к переписке проекта «Поддержка».")).toBeVisible();
    await expect(support).toContainText("Вы — оператор");
    await support.getByRole("button", { name: "Открыть проект Поддержка" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Текущий проект Поддержка" })).toBeVisible();
    await expect(page.getByRole("listbox", { name: "Диалоги" }).getByRole("option", { name: /Анна Смирнова/ })).toBeVisible();
  });

  test("switched-off projects: each role is told the next step it can take", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request, { inactive: ["p1", "p2"] });
    await expect(page.getByRole("heading", { name: "Проект выключен" })).toBeVisible();
    await expect(page.locator("main").getByText(/Работа продолжится, когда администратор установки включит его/)).toBeVisible();
    await expect(adminMenu(page)).toHaveCount(0);
    await expect(page.locator("main").getByRole("button")).toHaveCount(0);

    // A project administrator is sent to the connections of the switched-off project.
    await start(page, context, request, { account: "irina", inactive: ["p1", "p4"] });
    await expect(page.getByRole("heading", { name: "Проект выключен" })).toBeVisible();
    await page.getByRole("button", { name: "Настроить проект" }).click();
    const screen = page.getByRole("dialog", { name: "Без доступа" });
    await expect(screen.getByRole("tab", { name: "Подключения" })).toHaveAttribute("aria-selected", "true");
    await expect(screen.getByRole("textbox", { name: "ID группы поддержки" })).toHaveValue("-1001000000004");
    await page.keyboard.press("Escape");
    await expect(screen).toBeHidden();

    await start(page, context, request, { account: "admin", inactive: ["p1", "p2"] });
    await expect(page.getByRole("heading", { name: "Ваши проекты выключены" })).toBeVisible();
    await page.getByRole("button", { name: "Открыть проекты" }).click();
    await expect(page.getByRole("dialog", { name: "Проекты" })).toBeVisible();
  });

  test("a failed project list is reported as a failure, not as an empty installation, and can be retried", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await scenario(request, { me: "session", data: { account: "admin" } });
    await context.addCookies([SESSION_COOKIE]);
    let failing = true;
    await page.route("**/console/projects", (route) => failing && route.request().method() === "GET"
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "Сервер недоступен." }) })
      : route.continue());
    await page.goto("/console/");
    await expect(page.getByRole("heading", { name: "Не удалось загрузить проекты" })).toBeVisible();
    await expect(page.locator("main").getByText("Сервер недоступен.")).toBeVisible();
    await expect(page.locator(".notice")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /Создайте первый проект|Нет доступа/ })).toHaveCount(0);
    failing = false;
    await page.locator("main").getByRole("button", { name: "Повторить" }).click();
    await expect(page.getByRole("button", { name: "Текущий проект Поддержка" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Выберите диалог" })).toBeVisible();
  });

  test("an operator without projects is sent to an administrator, also on a phone", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request, { account: "pavel" });
    await expect(page.getByRole("heading", { name: "Нет доступа к проектам" })).toBeVisible();
    await expect(page.locator("main").getByText("Вам ещё не выдали доступ ни к одному проекту. Обратитесь к администратору установки или проекта.")).toBeVisible();
    await expect(adminMenu(page)).toHaveCount(0);
    // Phones hide the conversation panel without a dialogue: the list column explains instead.
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByRole("complementary", { name: "Список диалогов" }).getByRole("heading", { name: "Нет доступа к проектам" })).toBeVisible();
    await expect(page.locator("main")).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });
});

test.describe("project management", () => {
  test("members: the server's candidates are searched, access is granted from the keyboard and revoked after a confirmation", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request, { account: "admin", staff: 3 });
    const screen = await manage(page, "Поддержка");
    const members = screen.getByRole("list", { name: "Участники проекта" });
    await expect(members.getByRole("listitem")).toHaveText([/Администратор Установки/, /Ирина Соколова/, /Оператор Тест/]);
    await expect(members.getByRole("listitem").first().getByRole("button")).toHaveCount(0);
    await expect(members.getByRole("listitem").filter({ hasText: "Оператор Тест" })).toContainText("Telegram ID не привязан");

    const picker = screen.getByRole("combobox", { name: "Сотрудник" });
    await picker.focus();
    const options = screen.getByRole("listbox", { name: "Сотрудники" }).getByRole("option");
    // Active accounts without access only: members, the administrator and switched-off accounts are left out.
    await expect(options).toHaveText([/Павел Орлов/, /Сотрудник 1/, /Сотрудник 2/, /Сотрудник 3/]);
    await expect(picker).toHaveAttribute("aria-expanded", "true");
    await expect(screen.getByText("Выберите сотрудника из списка.")).toBeVisible();
    await picker.pressSequentially("сотр");
    await expect(options).toHaveText([/Сотрудник 1/, /Сотрудник 2/, /Сотрудник 3/]);
    // The first answer is highlighted and announced; the arrows move on from it.
    await expect(options.first()).toHaveAttribute("data-highlighted", "");
    await expect(picker).toHaveAttribute("aria-activedescendant", (await options.first().getAttribute("id"))!);
    await page.keyboard.press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("data-highlighted", "");
    await page.keyboard.press("Enter");
    await expect(picker).toHaveValue("Сотрудник 2 · staff-02");
    await expect(screen.getByText("Нажмите «Выдать доступ», чтобы добавить сотрудника.")).toBeVisible();

    // One request, even when the button is pressed again while it runs.
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/console/projects/p1/members", async (route) => {
      if (route.request().method() === "POST") await pending;
      await route.continue();
    });
    const grant = screen.getByRole("button", { name: /^Выдать доступ|^Выдаём/ });
    await grant.click();
    await expect(grant).toHaveAttribute("aria-disabled", "true");
    await grant.click({ force: true });
    release();
    await expect(screen.getByText("Доступ выдан: Сотрудник 2.")).toBeVisible();
    expect((await stubLog(request)).filter((entry) => entry.method === "POST" && entry.path === "/console/projects/p1/members")).toHaveLength(1);
    await page.unroute("**/console/projects/p1/members");
    await expect(members.getByRole("listitem")).toHaveCount(4);
    await expect(picker).toHaveValue("");

    await picker.fill("zzz");
    await expect(screen.getByText("Нет доступных сотрудников по этому запросу.")).toBeVisible();
    await page.route("**/member-candidates?**", (route) => route.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
    await picker.fill("сотр");
    await expect(screen.getByText("Не удалось загрузить сотрудников. Нажмите на поле, чтобы повторить.")).toBeVisible();
    await page.unroute("**/member-candidates?**");
    await picker.click();
    await expect(options).toHaveText([/Сотрудник 1/, /Сотрудник 3/]);
    await options.first().click();

    // A refused grant keeps the choice for another attempt.
    await page.route("**/console/projects/p1/members", (route) => route.request().method() === "POST"
      ? route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ detail: "Учётная запись недоступна." }) })
      : route.continue());
    await screen.getByRole("button", { name: "Выдать доступ" }).click();
    await expect(screen.getByRole("alert")).toHaveText("Учётная запись недоступна.");
    await expect(picker).toHaveValue("Сотрудник 1 · staff-01");
    await page.unroute("**/console/projects/p1/members");

    const irina = members.getByRole("listitem").filter({ hasText: "Ирина Соколова" });
    await irina.getByRole("button", { name: "Отозвать доступ: Ирина Соколова" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Отозвать доступ: Ирина Соколова?" });
    await expect(confirm.getByRole("button", { name: "Отмена" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirm).toBeHidden();
    await expect(screen).toBeVisible();
    await expect(irina).toBeVisible();
    await irina.getByRole("button", { name: "Отозвать доступ: Ирина Соколова" }).click();
    await confirm.getByRole("button", { name: "Отозвать доступ", exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(screen.getByText("Доступ отозван: Ирина Соколова. Переписка проекта сохранена.")).toBeVisible();
    await expect(irina).toHaveCount(0);
    await expect(members).toBeFocused();
  });

  test("the installation administrator hands a project over after a confirmation that names everyone", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request, { account: "admin" });
    const screen = await manage(page, "Второй проект");
    await screen.getByText("Сменить администратора проекта").click();
    await expect(screen.getByText(/Сейчас: вы \(admin\)/)).toBeVisible();
    await screen.getByRole("button", { name: "Передать проект" }).click();
    await expect(screen.getByRole("alert")).toHaveText("Выберите нового администратора из списка.");
    const picker = screen.getByRole("combobox", { name: "Новый администратор" });
    await expect(picker).toHaveAttribute("aria-invalid", "true");
    await expect(picker).toHaveAccessibleDescription(/Выберите нового администратора из списка./);
    await picker.fill("павел");
    await screen.getByRole("option", { name: /Павел Орлов/ }).click();
    await screen.getByRole("button", { name: "Передать проект" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Передать управление проектом?" });
    await expect(confirm).toContainText("Новый администратор проекта «Второй проект»: Павел Орлов · pavel.");
    await expect(confirm).toContainText("Вы потеряете доступ к проекту и его подключениям.");
    await confirm.getByRole("button", { name: "Передать проект" }).click();
    await expect(confirm).toBeHidden();
    await expect(screen.getByText("Новый администратор проекта: Павел Орлов.")).toBeVisible();
    // Connections belong to the new administrator now; the members tab stays.
    await expect(screen.getByRole("tab")).toHaveText(["Участники"]);
    await expect(screen.getByText(/Подключения и логотип настраивает администратор проекта/)).toBeVisible();
    const members = screen.getByRole("list", { name: "Участники проекта" });
    await expect(members.getByRole("listitem").first()).toContainText("Павел Орлов");
    await expect(members.getByRole("listitem").first()).toContainText("администратор проекта");
    await expect(members).not.toContainText("Администратор Установки");
  });

  test("connections: field errors before sending, a conflict keeps the input, unsaved changes ask before leaving", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request, { account: "admin" });
    const screen = await manage(page, "Поддержка");
    await screen.getByRole("tab", { name: "Подключения" }).click();
    await expect(screen.getByLabel("Токен бота")).toHaveAttribute("placeholder", "Ключ сохранён");
    await expect(screen.getByLabel("Ключ Web API")).toHaveAttribute("placeholder", "Не настроено");
    await expect(screen.getByText(/Базовый адрес API: http:\/\/127\.0\.0\.1:\d+\/projects\/p1\/api\/v1/)).toBeVisible();

    await screen.getByRole("checkbox", { name: "Отправлять события" }).check();
    expect(await leaveIsGuarded(page)).toBe(true);
    await screen.getByRole("button", { name: "Сохранить подключения" }).click();
    await expect(screen.getByText("Нужен адрес, чтобы отправлять события.")).toBeVisible();
    await expect(screen.getByText("Нужен секрет, чтобы отправлять события.")).toBeVisible();
    const hook = screen.getByRole("textbox", { name: "Адрес получателя" });
    await expect(hook).toBeFocused();
    await hook.fill("http://hooks.example.com");
    await expect(screen.getByText("Нужен адрес HTTPS.")).toBeVisible();
    await hook.fill("https://hooks.example.com/resolvate");
    await screen.getByLabel("Секрет подписи HMAC-SHA256").fill("s".repeat(40));
    await screen.getByRole("button", { name: "Сохранить подключения" }).click();
    await expect(screen.getByText("Подключения сохранены. Активный проект перезапустится автоматически.")).toBeVisible();
    await expect(screen.getByLabel("Секрет подписи HMAC-SHA256")).toHaveAttribute("placeholder", "Ключ сохранён");
    expect(await leaveIsGuarded(page)).toBe(false);

    // Retention rules: the collapsed section opens at the field to correct.
    const advanced = screen.getByText("Дополнительно: лимиты, темы и хранение архива");
    await advanced.click();
    await screen.getByRole("textbox", { name: "Хранить файлы, дней" }).fill("90");
    await advanced.click();
    await screen.getByRole("button", { name: "Сохранить подключения" }).click();
    await expect(screen.getByText("Файлы не могут храниться дольше переписки.")).toBeVisible();
    await expect(screen.getByRole("textbox", { name: "Хранить файлы, дней" })).toBeFocused();
    await screen.getByRole("textbox", { name: "Хранить файлы, дней" }).fill("30");

    const group = screen.getByRole("textbox", { name: "ID группы поддержки" });
    await group.fill("-1009999999999");
    await screen.getByRole("button", { name: "Сохранить подключения" }).click();
    await expect(screen.getByRole("alert")).toHaveText("Бот и группа закреплены за проектом. Для другого канала создайте проект.");
    await expect(group).toHaveValue("-1009999999999");

    await page.keyboard.press("Escape");
    const discard = page.getByRole("alertdialog", { name: "Не сохранять изменения?" });
    await expect(discard.getByRole("button", { name: "Вернуться к настройкам" })).toBeFocused();
    await discard.getByRole("button", { name: "Вернуться к настройкам" }).click();
    await expect(discard).toBeHidden();
    await expect(group).toHaveValue("-1009999999999");
    await screen.getByRole("button", { name: "Отменить изменения" }).click();
    await expect(group).toHaveValue("-1001000000001");
    await group.fill("-1008888888888");
    await screen.getByRole("button", { name: "Все проекты" }).click();
    await discard.getByRole("button", { name: "Не сохранять" }).click();
    await expect(page.getByRole("dialog", { name: "Проекты" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Настроить проект Поддержка" })).toBeFocused();
    expect(await leaveIsGuarded(page)).toBe(false);
  });

  test("logo: the file is checked and previewed, uploaded, replaced and removed; the app bar follows without a reload", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request, { account: "admin" });
    // A modal window hides the app bar from the accessibility tree, so the emblem is found by place.
    const emblem = page.locator("#workspace > header .project-logo");
    await expect(emblem).toHaveAttribute("src", "/console/projects/p1/logo?v=logo-v1");
    const screen = await manage(page, "Поддержка");
    await screen.getByRole("tab", { name: "Логотип" }).click();
    await expect(screen.getByText("Текущий логотип")).toBeVisible();
    const input = screen.getByLabel("Новое изображение");
    await screen.getByRole("button", { name: "Заменить логотип" }).click();
    await expect(screen.getByText("Выберите изображение PNG, JPEG или WebP до 2 МБ.")).toBeVisible();
    await input.setInputFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
    await expect(screen.getByText("Логотип: PNG, JPEG или WebP до 2 МБ.")).toBeVisible();
    await input.setInputFiles({ name: "big.png", mimeType: "image/png", buffer: Buffer.alloc(2 * 1024 * 1024 + 1) });
    await expect(screen.getByText("Логотип пустой или больше 2 МБ.")).toBeVisible();
    // The format is right but the bytes are not an image: the server refuses it, the file stays chosen.
    await input.setInputFiles({ name: "fake.png", mimeType: "image/png", buffer: Buffer.from("not an image at all") });
    await expect(screen.getByText("Предпросмотр недоступен; сервер проверит изображение при загрузке.")).toBeVisible();
    await screen.getByRole("button", { name: "Заменить логотип" }).click();
    await expect(screen.getByRole("alert")).toHaveText("Изображение не прошло проверку. Используйте PNG, JPEG или WebP.");
    await expect(screen.getByText("fake.png")).toBeVisible();

    await input.setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
    await expect(screen.locator(".logo-preview canvas")).toBeVisible();
    await expect(screen.getByRole("group", { name: "Выбранное изображение" })).toContainText("logo.png");
    await screen.getByRole("button", { name: "Заменить логотип" }).click();
    await expect(screen.getByText("Логотип заменён.")).toBeVisible();
    const version = createHash("sha256").update(PNG).digest("hex");
    await expect(emblem).toHaveAttribute("src", `/console/projects/p1/logo?v=${version}`);
    await expect(screen.locator(".logo-frame img")).toHaveAttribute("src", `/console/projects/p1/logo?v=${version}`);
    await expect(input).toHaveValue("");

    await screen.getByRole("button", { name: "Удалить логотип" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Удалить логотип проекта «Поддержка»?" });
    await expect(confirm.getByRole("button", { name: "Отмена" })).toBeFocused();
    await confirm.getByRole("button", { name: "Удалить логотип" }).click();
    await expect(screen.getByText("Логотип удалён.")).toBeVisible();
    await expect(screen.getByLabel("Изображение", { exact: true })).toBeFocused();
    await expect(emblem).toHaveCount(0);
    await expect(screen.getByText("Логотипа нет")).toBeVisible();
    await expect(screen.getByRole("button", { name: "Загрузить логотип" })).toBeVisible();
  });

  test("a save the server took stays saved when reading it back fails; a failed list refresh is shown over the old list", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request, { account: "admin" });
    const screen = await manage(page, "Поддержка");
    await screen.getByRole("tab", { name: "Подключения" }).click();
    let saved = false;
    await page.route("**/console/projects/p1/settings", async (route) => {
      if (route.request().method() === "POST") {
        saved = true;
        return route.continue();
      }
      return saved
        ? route.fulfill({ status: 502, contentType: "text/html", body: "<html>502</html>" })
        : route.continue();
    });
    await screen.getByRole("textbox", { name: "ID группы поддержки" }).fill("-1001000000001");
    await screen.getByText("Дополнительно: лимиты, темы и хранение архива").click();
    await screen.getByRole("textbox", { name: "Не больше сообщений в минуту" }).fill("25");
    await screen.getByRole("button", { name: "Сохранить подключения" }).click();
    await expect(screen.getByText("Подключения сохранены. Активный проект перезапустится автоматически.")).toBeVisible();
    await expect(screen.getByRole("alert")).toContainText("Запрос не выполнен. Повторите позже.");
    await expect(screen.getByRole("textbox", { name: "Не больше сообщений в минуту" })).toHaveValue("25");
    expect(await leaveIsGuarded(page)).toBe(false);
    await page.unroute("**/console/projects/p1/settings");

    await screen.getByRole("button", { name: "Все проекты" }).click();
    await page.keyboard.press("Escape");
    await page.route("**/console/projects", (route) => route.request().method() === "GET"
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "Сервер недоступен." }) })
      : route.continue());
    const dialog = await openWindow(page, "Проекты");
    await expect(dialog.getByRole("alert")).toContainText("Сервер недоступен. Список ниже может быть устаревшим.");
    await expect(row(dialog, "Проекты", "Поддержка")).toBeVisible();
  });

  test("an administration window that cannot load closes with a notice; the workspace and its draft stay", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request, { account: "admin" });
    await page.getByRole("listbox", { name: "Диалоги" }).getByRole("option", { name: /Анна Смирнова/ }).click();
    const composer = page.getByRole("textbox", { name: "Текст ответа" });
    await composer.fill("черновик до обновления");
    await page.route("**/console/assets/StaffDialog-*.js", (route) => route.abort());
    await adminMenu(page).click();
    await page.getByRole("menuitem", { name: "Сотрудники" }).click();
    await expect(page.getByRole("alert")).toHaveText("Не удалось загрузить раздел. Обновите страницу.");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(composer).toHaveValue("черновик до обновления");
  });

  test("switching a project off asks first; the operators' workspace follows", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request, { account: "admin" });
    await expect(page.getByRole("button", { name: "Текущий проект Поддержка" })).toBeVisible();
    const dialog = await openWindow(page, "Проекты");
    const support = row(dialog, "Проекты", "Поддержка");
    await support.getByRole("button", { name: "Выключить проект Поддержка" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Выключить проект «Поддержка»?" });
    await expect(confirm).toContainText("Данные и настройки сохранятся");
    await confirm.getByRole("button", { name: "Выключить проект" }).click();
    await expect(dialog.getByText("Проект «Поддержка» выключен. Данные и настройки сохранены.")).toBeVisible();
    await expect(support).toContainText("Выключен");
    await expect(support.getByRole("button", { name: /^Открыть/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Текущий проект Выберите проект" })).toBeVisible();
  });
});

test.describe("staff", () => {
  test("accounts with their links; creation with checks and a taken login; Telegram ID; switching off within the server's rules", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request, { account: "admin" });
    const dialog = await openWindow(page, "Сотрудники");
    const accounts = dialog.getByRole("list", { name: "Сотрудники" });
    await expect(accounts.getByRole("listitem")).toHaveCount(5);
    const self = row(dialog, "Сотрудники", "Администратор Установки");
    await expect(self).toContainText("Вы");
    await expect(self).toContainText("администратор установки");
    await expect(self.getByRole("button", { name: /^Отключить/ })).toHaveCount(0);
    await expect(row(dialog, "Сотрудники", "Ирина Соколова")).toContainText("Администратор проектов: «Без доступа»");
    await expect(row(dialog, "Сотрудники", "Бывший сотрудник")).toContainText("Отключён");

    await dialog.getByRole("searchbox", { name: "Найти сотрудника" }).fill("ирина");
    await expect(accounts.getByRole("listitem")).toHaveCount(1);
    await dialog.getByRole("searchbox", { name: "Найти сотрудника" }).fill("");

    await dialog.getByText("Добавить сотрудника").click();
    const create = dialog.getByRole("button", { name: "Создать аккаунт" });
    await create.click();
    await expect(dialog.getByRole("textbox", { name: "Имя" })).toBeFocused();
    await expect(dialog.getByText("Логин: 3–64 символа, латиница, цифры, точка, _ или -.").last()).toBeVisible();
    await dialog.getByRole("textbox", { name: "Имя" }).fill("Мария Иванова");
    await dialog.getByRole("textbox", { name: "Логин" }).fill("Maria");
    await dialog.getByLabel("Пароль", { exact: true }).fill("пароль-сотрудника-1");
    await dialog.getByLabel("Повторите пароль").fill("другой-пароль-123");
    await create.click();
    await expect(dialog.getByText("Пароли не совпадают.")).toBeVisible();
    await dialog.getByLabel("Повторите пароль").fill("пароль-сотрудника-1");
    await dialog.getByRole("textbox", { name: "Telegram ID · необязательно" }).fill("2002");
    await create.click();
    await expect(dialog.getByRole("alert")).toHaveText("Логин или Telegram ID уже используется.");
    await expect(dialog.getByRole("textbox", { name: "Имя" })).toHaveValue("Мария Иванова");
    await expect(dialog.getByLabel("Пароль", { exact: true })).toHaveValue("пароль-сотрудника-1");
    await dialog.getByRole("textbox", { name: "Telegram ID · необязательно" }).fill("3003");
    await create.click();
    await expect(dialog.getByText("Сотрудник «Мария Иванова» создан. Доступ к проектам выдаётся в разделе «Проекты».")).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Имя" })).toHaveValue("");
    await expect(dialog.getByLabel("Пароль", { exact: true })).toHaveValue("");
    await expect(row(dialog, "Сотрудники", "Мария Иванова")).toContainText("maria · сотрудник · Telegram ID 3003");

    await row(dialog, "Сотрудники", "Павел Орлов").getByRole("button", { name: "Telegram ID: Павел Орлов" }).click();
    const telegram = page.getByRole("dialog", { name: "Telegram ID: Павел Орлов" });
    await telegram.getByRole("textbox", { name: "Telegram ID" }).fill("12ab");
    await telegram.getByRole("button", { name: "Сохранить" }).click();
    await expect(telegram.getByText("Telegram ID — положительное целое число.")).toBeVisible();
    await telegram.getByRole("textbox", { name: "Telegram ID" }).fill("1001");
    await telegram.getByRole("button", { name: "Сохранить" }).click();
    await expect(telegram.getByRole("alert")).toHaveText("Этот Telegram ID уже используется.");
    await expect(telegram.getByRole("textbox", { name: "Telegram ID" })).toHaveValue("1001");
    await telegram.getByRole("textbox", { name: "Telegram ID" }).fill("4004");
    await telegram.getByRole("button", { name: "Сохранить" }).click();
    await expect(telegram).toBeHidden();
    await expect(dialog.getByText("Telegram ID сохранён: Павел Орлов.")).toBeVisible();
    await expect(row(dialog, "Сотрудники", "Павел Орлов")).toContainText("Telegram ID 4004");
    await row(dialog, "Сотрудники", "Ирина Соколова").getByRole("button", { name: "Telegram ID: Ирина Соколова" }).click();
    await page.getByRole("dialog", { name: "Telegram ID: Ирина Соколова" }).getByRole("button", { name: "Отвязать" }).click();
    await expect(dialog.getByText("Telegram ID отвязан: Ирина Соколова.")).toBeVisible();
    await expect(row(dialog, "Сотрудники", "Ирина Соколова")).toContainText("Telegram ID не привязан");

    // The server keeps project administrators active until their projects are handed over.
    await row(dialog, "Сотрудники", "Ирина Соколова").getByRole("button", { name: "Отключить: Ирина Соколова" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Отключить аккаунт irina?" });
    await confirm.getByRole("button", { name: "Отключить", exact: true }).click();
    await expect(confirm.getByRole("alert")).toHaveText("Сначала передайте управление проектами этого аккаунта.");
    await confirm.getByRole("button", { name: "Отмена" }).click();
    await row(dialog, "Сотрудники", "Павел Орлов").getByRole("button", { name: "Отключить: Павел Орлов" }).click();
    await page.getByRole("alertdialog", { name: "Отключить аккаунт pavel?" }).getByRole("button", { name: "Отключить", exact: true }).click();
    await expect(dialog.getByText("Аккаунт pavel отключён, сессии аккаунта завершены.")).toBeVisible();
    await expect(row(dialog, "Сотрудники", "Павел Орлов")).toContainText("Отключён");
    await row(dialog, "Сотрудники", "Павел Орлов").getByRole("button", { name: "Включить: Павел Орлов" }).click();
    await expect(dialog.getByText("Аккаунт pavel включён.")).toBeVisible();
    await expect(row(dialog, "Сотрудники", "Павел Орлов")).toContainText("Активен");
  });

  test("a project administrator manages projects but not staff; the server refuses staff to anyone else", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request, { account: "irina" });
    await adminMenu(page).click();
    await expect(page.getByRole("menuitem")).toHaveText(["Проекты"]);
    await page.keyboard.press("Escape");
    const response = await page.request.get("/console/accounts");
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ detail: "Требуются права администратора." });
    const dialog = await openWindow(page, "Проекты");
    await expect(row(dialog, "Проекты", "Поддержка").getByRole("button", { name: /^Настроить/ })).toHaveCount(0);
    await expect(row(dialog, "Проекты", "Без доступа").getByRole("button", { name: "Настроить проект Без доступа" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^(Включить|Выключить) проект/ })).toHaveCount(0);
    await expect(dialog.getByText("Новый проект")).toHaveCount(0);
  });
});

test.describe("layout and keyboard", () => {
  test("narrow screens: the administration icon has a tooltip and the windows take the whole screen", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 740 });
      await start(page, context, request, { account: "admin" });
      const trigger = adminMenu(page);
      await expect(trigger).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await expect(trigger).toHaveAccessibleName("Управление");
      await trigger.focus();
      await expect(page.locator(".admin-trigger-label")).toBeVisible();
      await page.mouse.move(1, 700);
      await trigger.blur();
      await expect(page.locator(".admin-trigger-label")).toBeHidden();
      await trigger.hover();
      await expect(page.locator(".admin-trigger-label")).toBeVisible();
      const dialog = await openWindow(page, "Проекты");
      const box = (await dialog.boundingBox())!;
      expect(Math.round(box.width)).toBe(width);
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
  });

  test("keyboard: the menu, the windows, the tabs and focus return", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request, { account: "admin" });
    const trigger = adminMenu(page);
    await trigger.focus();
    // The text is visible on wide screens: no extra label.
    await expect(trigger).toContainText("Управление");
    await expect(page.locator(".admin-trigger-label")).toBeHidden();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Проекты" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const staff = page.getByRole("dialog", { name: "Сотрудники" });
    await expect(staff).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(staff).toBeHidden();
    await expect(trigger).toBeFocused();

    const screen = await manage(page, "Поддержка");
    const members = screen.getByRole("tab", { name: "Участники" });
    await expect(members).toHaveAttribute("aria-selected", "true");
    await members.focus();
    await page.keyboard.press("ArrowRight");
    await expect(screen.getByRole("tab", { name: "Подключения" })).toBeFocused();
    await expect(screen.getByRole("tab", { name: "Подключения" })).toHaveAttribute("aria-selected", "true");
    await expect(screen.getByLabel("Токен бота")).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(screen.getByRole("combobox", { name: "Сотрудник" })).toBeVisible();
    await screen.getByRole("button", { name: "Все проекты" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});
