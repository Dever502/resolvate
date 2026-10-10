import type { Page } from "@playwright/test";
import { PASSWORD, SESSION_COOKIE, expect, scenario, stubLog, test } from "./fixtures";

// Keyboard, focus and screen-reader semantics of the production build under the console CSP
// (the consoleErrors fixture fails a test on any CSP violation).
const CONSOLE = "/console/";
const THEME = {
  system: "Системная тема · переключить на светлую",
  light: "Светлая тема · переключить на тёмную",
  dark: "Тёмная тема · переключить на системную",
};

// The visible text of the open tooltip. Reka also keeps a visually hidden copy of it inside the content,
// which IconButton hides from screen readers together with the tooltip.
const tooltipText = (page: Page): Promise<string> =>
  page.locator(".tooltip").evaluate((element) =>
    [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join("").trim());

test.describe("keyboard and screen readers", () => {
  test("sign-in: names, Tab order, Enter, and a failed attempt keeps focus and blocks a second submit", async ({ page, request, consoleErrors }) => {
    void consoleErrors;
    await scenario(request, { me: "session", loginDelay: 400 });
    await page.goto(CONSOLE);
    const login = page.getByRole("textbox", { name: "Логин" });
    const password = page.getByRole("textbox", { name: "Пароль" });
    const submit = page.locator('#login-form button[type="submit"]');
    await expect(login).toBeFocused();
    await expect(page.locator("body")).toMatchAriaSnapshot(`
      - main:
        - heading "Вход в поддержку" [level=1]
        - textbox "Логин"
        - textbox "Пароль"
        - button "Войти"
    `);

    await page.keyboard.type("operator");
    await page.keyboard.press("Tab");
    await expect(password).toBeFocused();
    await page.keyboard.type("wrong password!");
    await page.keyboard.press("Tab");
    await expect(submit).toBeFocused();
    await page.keyboard.press("Enter");
    // While the request runs the button is unavailable, keeps focus and ignores another Enter.
    await expect(submit).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert")).toHaveText("Неверный логин или пароль.");
    await expect(submit).toBeFocused();
    await expect(submit).not.toHaveAttribute("aria-disabled");
    expect((await stubLog(request)).filter((entry) => entry.path === "/console/login")).toHaveLength(1);

    await password.fill(PASSWORD);
    await password.press("Enter");
    await expect(page.locator("#workspace")).toBeVisible();
    // The form that held focus is gone: focus starts at the workspace heading, not on the page.
    await expect(page.getByRole("heading", { name: "Диалоги" })).toBeFocused();
  });

  test("slow sign-in cannot show an old password error against newly edited credentials", async ({ page, request, consoleErrors }) => {
    void consoleErrors;
    await scenario(request, { me: "session" });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/console/login", async route => {
      await pending;
      await route.continue();
    });
    await page.goto(CONSOLE);
    const login = page.getByRole("textbox", { name: "Логин" });
    const password = page.getByRole("textbox", { name: "Пароль" });
    const submit = page.locator('#login-form button[type="submit"]');
    await login.fill("operator");
    await password.fill("wrong password!");
    await password.press("Enter");
    await expect(submit).toHaveText("Проверяем…");
    await expect(login).not.toBeEditable();
    await expect(password).not.toBeEditable();
    await expect(password).toBeFocused();
    // Real keyboard edits and another Enter while the request runs must not change the
    // credentials on screen or launch a second, overlapping authentication request.
    await password.press("ControlOrMeta+a");
    await password.pressSequentially("correct horse battery");
    await expect(password).toHaveValue("wrong password!");
    await password.press("Enter");
    release();
    await expect(page.getByRole("alert")).toHaveText("Неверный логин или пароль.");
    expect((await stubLog(request)).filter(entry => entry.path === "/console/login")).toHaveLength(1);
    await expect(login).toBeEditable();
    await expect(password).toBeEditable();
    await password.fill(PASSWORD);
    await expect(page.locator("#login-error")).toBeEmpty();
    await password.press("Enter");
    await expect(page.locator("#workspace")).toBeVisible();
    expect((await stubLog(request)).filter(entry => entry.path === "/console/login")).toHaveLength(2);
  });

  test("workspace: landmarks, Tab order, tooltips on focus and hover, Esc, Enter and Space", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await scenario(request, { me: "session" });
    await context.addCookies([SESSION_COOKIE]);
    await page.goto(CONSOLE);
    const tree = `
      - banner "Проект и управление":
        - button "Текущий проект Поддержка"
        - text: Resolvate
      - complementary "Список диалогов":
        - heading "Диалоги" [level=1]
        - button "Открыть архив"
        - searchbox "Поиск клиента"
        - tablist "Папки диалогов":
          - tab "Все" [selected]
          - tab "VIP"
        - button "Управление общими папками"
        - tabpanel "Все":
          - listbox "Диалоги":
            - 'option /Анна Смирнова .* Непрочитанных: 2/'
            - 'option /Борис Петров .* Непрочитанных: 1/'
        - button "${THEME.system}"
        - button "Выйти"
      - separator "Ширина списка диалогов"
      - main:
        - heading "Выберите диалог" [level=2]
    `;
    await expect(page.locator("body")).toMatchAriaSnapshot(tree);
    await expect(page.getByRole("heading", { name: "Диалоги" })).toBeFocused();

    const tooltip = page.locator(".tooltip");
    const theme = page.locator("[data-theme-toggle]");
    const logout = page.getByRole("button", { name: "Выйти" });
    // The list column from top to bottom; the list itself is one stop, at its first dialogue.
    for (const stop of [
      page.getByRole("button", { name: "Открыть архив" }),
      page.getByRole("searchbox", { name: "Поиск клиента" }),
      page.getByRole("tab", { name: "Все" }),
      page.getByRole("button", { name: "Управление общими папками" }),
      page.getByRole("option", { name: /Анна Смирнова/ }),
      theme,
    ]) {
      await page.keyboard.press("Tab");
      await expect(stop).toBeFocused();
    }
    await expect.poll(() => tooltipText(page)).toBe(THEME.system);
    // The label is the button's name only: the visible tooltip is neither a description nor a tree node.
    await expect(theme).toHaveAccessibleName(THEME.system);
    await expect(theme).toHaveAccessibleDescription("");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await expect(page.locator("body")).toMatchAriaSnapshot(tree);

    await page.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();
    await expect(theme).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(theme).toHaveAccessibleName(THEME.light);
    await expect(theme).toBeFocused();
    await page.keyboard.press("Space");
    await expect(theme).toHaveAccessibleName(THEME.dark);

    await page.keyboard.press("Tab");
    await expect(logout).toBeFocused();
    await expect.poll(() => tooltipText(page)).toBe("Выйти");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("separator", { name: "Ширина списка диалогов" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(theme).toBeFocused();
    await expect.poll(() => tooltipText(page)).toBe(THEME.dark);

    await page.keyboard.press("Escape");
    await logout.hover();
    await expect.poll(() => tooltipText(page)).toBe("Выйти");
    await page.mouse.move(1, 1);
    await expect(tooltip).toBeHidden();
  });

  test("sign-out from the keyboard: a failure is announced and keeps focus, success returns to the login field", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await scenario(request, { me: "session", logout: 502 });
    await context.addCookies([SESSION_COOKIE]);
    await page.goto(CONSOLE);
    await expect(page.getByRole("heading", { name: "Диалоги" })).toBeFocused();
    const logout = page.getByRole("button", { name: "Выйти" });
    await logout.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert")).toHaveText("Запрос не выполнен. Повторите позже.");
    await expect(logout).toBeFocused();

    await scenario(request, { me: "session" });
    await page.keyboard.press("Enter");
    await expect(page.locator("#login-screen")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Логин" })).toBeFocused();
  });

  test("a lost connection is reported in the console's words, not the browser's", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await scenario(request, { me: "session" });
    await page.goto(CONSOLE);
    await page.route("**/console/login", (route) => route.abort("connectionreset"));
    await page.getByRole("textbox", { name: "Логин" }).fill("operator");
    await page.getByRole("textbox", { name: "Пароль" }).fill(PASSWORD);
    await page.getByRole("textbox", { name: "Пароль" }).press("Enter");
    await expect(page.getByRole("alert")).toHaveText("Нет связи с сервером.");

    await context.addCookies([SESSION_COOKIE]);
    await page.goto(CONSOLE);
    await page.route("**/console/logout", (route) => route.abort("connectionreset"));
    await page.getByRole("button", { name: "Выйти" }).click();
    await expect(page.getByRole("alert")).toHaveText("Нет связи с сервером.");
  });
});
