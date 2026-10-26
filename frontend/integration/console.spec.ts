import type { Page } from "@playwright/test";
import { expect, test } from "../e2e/fixtures";

const PASSWORD = "browser-test-password-only";
const FIRST = "00000000-0000-4000-8000-000000000101";
const SECOND = "00000000-0000-4000-8000-000000000102";
const TICKET = "00000000-0000-4000-8000-000000000201";
const OTHER_TICKET = "00000000-0000-4000-8000-000000000202";

async function signIn(page: Page, login: string): Promise<void> {
  await page.goto("/console/");
  await page.getByRole("textbox", { name: "Логин" }).fill(login);
  await page.getByRole("textbox", { name: "Пароль", exact: true }).fill(PASSWORD);
  await page.getByRole("textbox", { name: "Пароль", exact: true }).press("Enter");
  await expect(page.locator("#workspace")).toBeVisible();
}

test("real login, PostgreSQL-backed reply, reload and logout; project access and CSRF remain enforced", async ({ page, consoleErrors }) => {
  void consoleErrors;
  await signIn(page, "operator");
  await page.goto(`/console/?project=${FIRST}&ticket=${TICKET}`);
  const history = page.getByRole("region", { name: "Переписка" });
  await expect(history).toContainText("Hello from Browser customer");
  await expect(page.getByRole("button", { name: "Текущий проект Browser project" })).toBeVisible();
  const input = page.getByRole("textbox", { name: "Текст ответа" });
  await input.fill("Reply persisted through the real API");
  const sent = page.waitForResponse(response => response.url().endsWith(`/tickets/${TICKET}/send`) && response.request().method() === "POST");
  await input.press("Enter");
  const response = await sent;
  expect(response.status(), await response.text()).toBe(200);
  await expect(input).toHaveValue("");
  await page.reload();
  await expect(history).toContainText("Reply persisted through the real API");

  // Real HTTP checks use this browser's authenticated cookies, not stub sessions.
  const me = await (await page.request.get("/console/me")).json();
  expect(me.csrf).toBeTruthy();
  const origin = new URL(page.url()).origin;
  const headers = { Origin: origin, "X-CSRF-Token": me.csrf as string };
  const forbidden = await page.request.post(`/console/projects/${SECOND}/tickets/${OTHER_TICKET}/sync`, { headers, data: { known: {} } });
  expect([403, 404]).toContain(forbidden.status());
  const noCsrf = await page.request.post(`/console/projects/${FIRST}/folders`, { headers: { Origin: origin }, data: { name: "Forbidden folder" } });
  expect(noCsrf.status()).toBe(403);
  const staff = await page.request.get("/console/accounts");
  expect(staff.status()).toBe(403);

  await page.getByRole("button", { name: /Меню аккаунта:/ }).click();
  await page.getByRole("menuitem", { name: "Выйти", exact: true }).click();
  await expect(page.locator("#login-screen")).toBeVisible();
  expect((await page.request.get("/console/me")).status()).toBe(401);
});

test("administrator creates an employee and a project via the actual API and sees them after reload", async ({ page, consoleErrors }) => {
  void consoleErrors;
  await signIn(page, "owner");
  await page.getByRole("button", { name: "Управление", exact: true }).click();
  await page.getByRole("menuitem", { name: "Сотрудники", exact: true }).click();
  const staff = page.getByRole("dialog", { name: "Сотрудники", exact: true });
  await staff.locator("summary").filter({ hasText: "Добавить сотрудника" }).click();
  await staff.getByLabel("Имя", { exact: true }).fill("Browser employee");
  await staff.getByLabel("Логин", { exact: true }).fill("browser_employee");
  await staff.getByLabel("Пароль", { exact: true }).fill(PASSWORD);
  await staff.getByLabel("Повторите пароль", { exact: true }).fill(PASSWORD);
  await staff.getByRole("button", { name: "Создать аккаунт", exact: true }).click();
  await expect(staff.getByRole("list", { name: "Сотрудники" })).toContainText("Browser employee");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Управление", exact: true }).click();
  await page.getByRole("menuitem", { name: "Проекты", exact: true }).click();
  const projects = page.getByRole("dialog", { name: "Проекты", exact: true });
  await projects.locator("summary").filter({ hasText: "Новый проект" }).click();
  await projects.getByLabel("Название", { exact: true }).fill("Created by browser");
  await projects.locator('form button[type="submit"]').click();
  await expect(projects.getByRole("list", { name: "Проекты" })).toContainText("Created by browser");
  await page.reload();
  await page.getByRole("button", { name: "Управление", exact: true }).click();
  await page.getByRole("menuitem", { name: "Проекты", exact: true }).click();
  await expect(projects.getByRole("list", { name: "Проекты" })).toContainText("Created by browser");
  // Disabling is deliberate: this test must never start a real Telegram runtime.
  const row = projects.getByRole("listitem").filter({ hasText: "Created by browser" });
  await expect(row).toContainText("Выключен");
});

test("commands use the project API, notes stay internal, retries do not duplicate", async ({ page, consoleErrors }) => {
  void consoleErrors;
  await signIn(page, "operator");
  await page.goto(`/console/?project=${FIRST}&ticket=${TICKET}`);
  const input = page.getByRole("textbox", { name: "Текст ответа" });
  await expect(input).toBeEditable();
  await input.fill("/note ");
  await expect(page.getByText("/note <текст> — Добавить", { exact: false })).toBeVisible();
  await input.fill("/note Browser internal note");
  // The server adds the note, but its answer is lost on the way back: the outcome is unknown and the key is kept.
  const keys: string[] = [];
  await page.route(`**/tickets/${TICKET}/commands/note`, async route => {
    keys.push(route.request().headers()["x-idempotency-key"]!);
    if (keys.length > 1) return route.continue();
    const answer = await route.fetch();
    expect(answer.status(), await answer.text()).toBe(200);
    await route.abort("connectionreset");
  });
  await input.press("Enter");
  await expect(page.locator(".command-unknown")).toContainText("Результат /note неизвестен");
  await page.reload();
  await expect(page.locator(".command-unknown")).toContainText("Результат /note неизвестен");
  await expect(input).toHaveValue("/note Browser internal note");
  await expect(page.getByText("/note <текст> — Добавить", { exact: false })).toBeVisible();
  // Repeated under the same key, the server answers as before and adds nothing.
  await input.press("Enter");
  await expect(page.locator(".command-toast-region")).toHaveText("Заметка добавлена.");
  await expect(input).toHaveValue("");
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  const me = await (await page.request.get("/console/me")).json();
  const headers = { Origin: new URL(page.url()).origin, "X-CSRF-Token": me.csrf,
    "X-Idempotency-Key": crypto.randomUUID() };
  const notes = await page.request.post(`/console/projects/${FIRST}/tickets/${TICKET}/commands/notes`, { headers, data: {} });
  expect(notes.status()).toBe(200);
  expect((await notes.json()).message.match(/Browser internal note/g)).toHaveLength(1);
  const foreign = await page.request.get(`/console/projects/${SECOND}/commands`);
  expect([403, 404]).toContain(foreign.status());
});

test("a real multipart image is stored, rendered under CSP and still available after reload", async ({ page, consoleErrors }) => {
  void consoleErrors;
  await signIn(page, "operator");
  await page.goto(`/console/?project=${FIRST}&ticket=${TICKET}`);
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 24;
    canvas.height = 16;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#123456";
    context.fillRect(0, 0, 24, 16);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await page.locator('input[type="file"]').setInputFiles({ name: "real.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await expect(page.getByRole("group", { name: "Выбранные вложения" }).locator("canvas")).toBeVisible();
  const sent = page.waitForResponse(response => response.url().endsWith(`/tickets/${TICKET}/send`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  const response = await sent;
  expect(response.status(), await response.text()).toBe(200);
  await expect(page.getByRole("group", { name: "Выбранные вложения" })).toBeHidden();
  await page.reload();
  const image = page.getByRole("region", { name: "Переписка" }).getByRole("button", { name: "Открыть изображение" }).last().locator("img");
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
});
