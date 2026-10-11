import type { APIRequestContext, BrowserContext, Locator, Page } from "@playwright/test";
import { PASSWORD, SESSION_COOKIE, expect, scenario, stubLog, test } from "./fixtures";

// Passwords and the installation's administrator on the production build, against the stub's
// installation routes (e2e/stub/admin.mjs: the backend's checks, answers and ended sessions).
const NEW_PASSWORD = "новый пароль 2026";

async function start(page: Page, context: BrowserContext, request: APIRequestContext, data: object = {}) {
  await scenario(request, { me: "session", data });
  await context.addCookies([SESSION_COOKIE]);
  await page.goto("/console/");
  await expect(page.locator("#workspace")).toBeVisible();
}

async function signIn(page: Page, login: string, password: string) {
  await page.getByRole("textbox", { name: "Логин" }).fill(login);
  await page.getByRole("textbox", { name: "Пароль" }).fill(password);
  await page.getByRole("textbox", { name: "Пароль" }).press("Enter");
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: /Меню аккаунта:/ }).click();
  await page.getByRole("menuitem", { name: "Выйти" }).click();
  await expect(page.locator("#login-screen")).toBeVisible();
}

async function openStaff(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Управление", exact: true }).click();
  await page.getByRole("menuitem", { name: "Сотрудники" }).click();
  const dialog = page.getByRole("dialog", { name: "Сотрудники" });
  await expect(dialog.getByRole("list", { name: "Сотрудники" })).toBeVisible();
  return dialog;
}

const row = (dialog: Locator, name: string) => dialog.getByRole("list", { name: "Сотрудники" }).getByRole("listitem").filter({ hasText: name });

test("own password: checks before sending, a refused current password keeps the form, success returns to sign-in", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await start(page, context, request);
  const trigger = page.getByRole("button", { name: /Меню аккаунта:/ });
  await trigger.click();
  await page.getByRole("menuitem", { name: "Сменить пароль" }).click();
  const dialog = page.getByRole("dialog", { name: "Сменить пароль" });
  await expect(dialog).toContainText("все сессии вашего аккаунта завершатся, включая эту");
  const current = dialog.getByLabel("Текущий пароль вашего аккаунта");
  const next = dialog.getByLabel("Новый пароль", { exact: true });
  const repeat = dialog.getByLabel("Повторите новый пароль");
  await expect(current).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.getByRole("menuitem", { name: "Сменить пароль" }).click();
  // The window starts empty: nothing typed before stays in it.
  await expect(current).toHaveValue("");
  await current.fill("wrong password!");
  await next.fill("short");
  // Named by what it does, which changes to "Сохраняем…" while the request runs.
  const submit = dialog.locator('form button[type="submit"]');
  await submit.click();
  await expect(dialog.getByText("Пароль: от 12 до 128 символов.")).toBeVisible();
  await expect(next).toBeFocused();
  await next.fill(NEW_PASSWORD);
  await repeat.fill(`${NEW_PASSWORD}!`);
  await submit.click();
  await expect(dialog.getByText("Новые пароли не совпадают.")).toBeVisible();
  await expect(repeat).toBeFocused();
  await repeat.fill(NEW_PASSWORD);
  await submit.click();
  await expect(dialog.getByText("Неверный текущий пароль вашего аккаунта.")).toBeVisible();
  await expect(current).toBeFocused();
  await expect(current).toHaveAttribute("aria-invalid", "true");
  await expect(next).toHaveValue(NEW_PASSWORD);
  await expect(page.locator("#workspace")).toBeVisible();

  // A slow answer: the button waits, Esc does not close the window, a second press sends nothing.
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/console/password", async (route) => { await pending; await route.continue(); });
  const sentBefore = (await stubLog(request)).filter((entry) => entry.path === "/console/password").length;
  await current.fill(PASSWORD);
  await submit.click();
  await expect(submit).toHaveAttribute("aria-disabled", "true");
  await submit.click({ force: true });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  release();
  await expect(page.locator("#login-screen")).toBeVisible();
  await expect(page.locator("#login-error")).toHaveText("Пароль изменён. Войдите с новым паролем.");
  await expect(page.locator("#login-error")).toHaveClass(/success/);
  // The refused attempt above plus exactly one for the slow submit pressed twice.
  const sent = (await stubLog(request)).filter((entry) => entry.path === "/console/password");
  expect(sent).toHaveLength(sentBefore + 1);
  expect(page.url()).not.toContain(encodeURIComponent(NEW_PASSWORD));

  await signIn(page, "operator", PASSWORD);
  await expect(page.locator("#login-error")).toHaveText("Неверный логин или пароль.");
  await signIn(page, "operator", NEW_PASSWORD);
  await expect(page.locator("#workspace")).toBeVisible();
});

test("employee password reset: confirmed by name, refused with a wrong own password, ends only that account's sessions", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await start(page, context, request, { account: "admin" });
  const staff = await openStaff(page);
  await row(staff, "Павел Орлов").getByRole("button", { name: "Сбросить пароль: Павел Орлов" }).click();
  const dialog = page.getByRole("dialog", { name: "Сброс пароля: pavel" });
  const current = dialog.getByLabel("Текущий пароль вашего аккаунта");
  await expect(current).toBeFocused();
  await expect(dialog).toContainText("права и доступы не изменятся");
  await current.fill("wrong password!");
  await dialog.getByLabel("Новый пароль сотрудника").fill(NEW_PASSWORD);
  await dialog.getByLabel("Повторите новый пароль").fill(NEW_PASSWORD);
  await dialog.getByRole("button", { name: "Сбросить пароль" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Сбросить пароль аккаунта pavel?" });
  await expect(confirm.getByRole("button", { name: "Отмена" })).toBeFocused();
  await confirm.getByRole("button", { name: "Сбросить пароль" }).click();
  await expect(confirm).toBeHidden();
  await expect(dialog.getByText("Неверный текущий пароль вашего аккаунта.")).toBeVisible();
  await expect(current).toBeFocused();

  await current.fill(PASSWORD);
  await dialog.getByRole("button", { name: "Сбросить пароль" }).click();
  await confirm.getByRole("button", { name: "Сбросить пароль" }).click();
  await expect(dialog).toBeHidden();
  await expect(staff.getByText("Пароль аккаунта pavel изменён, сессии аккаунта завершены. Передайте новый пароль сотруднику лично.")).toBeVisible();
  // The administrator's own session goes on; Pavel signs in with the new password.
  await page.keyboard.press("Escape");
  await expect(page.locator("#workspace")).toBeVisible();
  await signOut(page);
  await signIn(page, "pavel", PASSWORD);
  await expect(page.locator("#login-error")).toHaveText("Неверный логин или пароль.");
  await signIn(page, "pavel", NEW_PASSWORD);
  await expect(page.getByRole("heading", { name: "Нет доступа к проектам" })).toBeVisible();
});

test("a reset of the own account from the list ends this session like a change", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await start(page, context, request, { account: "admin" });
  const staff = await openStaff(page);
  await row(staff, "Администратор Установки").getByRole("button", { name: "Сбросить пароль: Администратор Установки" }).click();
  const dialog = page.getByRole("dialog", { name: "Сброс пароля: admin" });
  await dialog.getByLabel("Текущий пароль вашего аккаунта").fill(PASSWORD);
  await dialog.getByLabel("Новый пароль сотрудника").fill(NEW_PASSWORD);
  await dialog.getByLabel("Повторите новый пароль").fill(NEW_PASSWORD);
  await dialog.getByRole("button", { name: "Сбросить пароль" }).click();
  await page.getByRole("alertdialog", { name: "Сбросить пароль аккаунта admin?" }).getByRole("button", { name: "Сбросить пароль" }).click();
  await expect(page.locator("#login-screen")).toBeVisible();
  await expect(page.locator("#login-error")).toHaveText("Пароль изменён. Войдите с новым паролем.");
});

test("handing the installation over: both people named, a confirmation, then sign-in; the rights move with it", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await start(page, context, request, { account: "admin" });
  const staff = await openStaff(page);
  await staff.getByText("Передать управление установкой").click();
  await expect(staff.getByText("Сейчас администратор установки — вы (Администратор Установки · admin).", { exact: false })).toBeVisible();
  await staff.getByRole("button", { name: "Передать управление" }).click();
  await expect(staff.getByText("Выберите нового администратора установки из списка.")).toBeVisible();
  const picker = staff.getByRole("combobox", { name: "Новый администратор установки" });
  await picker.focus();
  // Active accounts other than this one; switched-off accounts cannot take the installation.
  await expect(staff.getByRole("listbox", { name: "Сотрудники" }).getByRole("option")).toHaveText([/Ирина Соколова/, /Оператор Тест/, /Павел Орлов/]);
  await picker.fill("ирина");
  await staff.getByRole("option", { name: /Ирина Соколова/ }).click();
  await staff.getByRole("button", { name: "Передать управление" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Передать управление установкой?" });
  await expect(confirm).toContainText("Новый администратор установки: Ирина Соколова · irina.");
  await expect(confirm).toContainText("Вы станете сотрудником, ваша сессия завершится");
  await expect(confirm.getByRole("button", { name: "Отмена" })).toBeFocused();
  await confirm.getByRole("button", { name: "Передать управление" }).click();
  await expect(page.locator("#login-screen")).toBeVisible();
  await expect(page.locator("#login-error")).toHaveText("Управление установкой передано: Ирина Соколова (irina). Войдите снова.");

  // The previous administrator keeps project administration but not the staff.
  await signIn(page, "admin", PASSWORD);
  await expect(page.getByRole("button", { name: "Меню аккаунта: Администратор Установки, Оператор" })).toBeVisible();
  await page.getByRole("button", { name: "Управление", exact: true }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["Проекты"]);
  await page.keyboard.press("Escape");
  await signOut(page);
  await signIn(page, "irina", PASSWORD);
  await expect(page.getByRole("button", { name: "Меню аккаунта: Ирина Соколова, Администратор установки" })).toBeVisible();
  await page.getByRole("button", { name: "Управление", exact: true }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["Проекты", "Сотрудники"]);
});

test("a refused transfer keeps the session and says why in the confirmation", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await start(page, context, request, { account: "admin" });
  const staff = await openStaff(page);
  await staff.getByText("Передать управление установкой").click();
  const picker = staff.getByRole("combobox", { name: "Новый администратор установки" });
  await picker.fill("павел");
  await staff.getByRole("option", { name: /Павел Орлов/ }).click();
  await page.route("**/console/installation/admin", (route) => route.fulfill({
    status: 404, contentType: "application/json", body: JSON.stringify({ detail: "Активная учётная запись с таким логином не найдена." }),
  }));
  await staff.getByRole("button", { name: "Передать управление" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Передать управление установкой?" });
  await confirm.getByRole("button", { name: "Передать управление" }).click();
  await expect(confirm.getByRole("alert")).toHaveText("Активная учётная запись с таким логином не найдена.");
  await confirm.getByRole("button", { name: "Отмена" }).click();
  await expect(page.locator("#workspace")).toBeVisible();
  await expect(picker).toHaveValue("Павел Орлов · pavel");
});
