import { test, expect, scenario, SESSION_COOKIE, stubLog } from "./fixtures";

const commands = [
  { name: "info", description: "Информация о клиенте", arguments: "", mutation: false },
  { name: "note", description: "Добавить внутреннюю заметку", arguments: "<текст>", mutation: true },
];

test.beforeEach(async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await scenario(request, { me: "session" });
  await context.addCookies([SESSION_COOKIE]);
  await page.route("**/console/projects/*/commands", route => route.fulfill({ json: commands }));
  await page.goto("/console/");
  await page.getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(page.getByRole("textbox", { name: "Текст ответа" })).toBeEditable();
});

test("slash selects then executes a command, never a customer message; hash still opens replies", async ({ page, request, consoleErrors }) => {
  void consoleErrors;
  const posts: unknown[] = [];
  await page.route("**/tickets/*/commands/info", async route => {
    posts.push(route.request().postDataJSON());
    await route.fulfill({ json: { status: "completed", message: "Информация только для оператора" } });
  });
  const input = page.getByRole("textbox", { name: "Текст ответа" });
  await input.fill("/");
  const list = page.getByRole("listbox", { name: "Доступные команды" });
  await expect(list.getByRole("option")).toHaveCount(2);
  await expect(input).toBeFocused();
  await input.press("Enter");
  await expect(input).toHaveValue("/info ");
  expect(posts).toHaveLength(0);
  await input.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Информация только" })).toBeVisible();
  expect(posts).toEqual([{ arguments: "" }]);
  expect((await stubLog(request)).filter(item => item.path.endsWith("/send"))).toEqual([]);
  await input.fill("");
  await input.pressSequentially("#");
  await expect(page.getByRole("listbox", { name: "Группы ответов" })).toBeVisible();
});

test("lost command response and reload retain the key; invalid arguments and IME execute nothing", async ({ page, request, consoleErrors }) => {
  void consoleErrors;
  const keys: string[] = [];
  await page.route("**/tickets/*/commands/note", async route => {
    keys.push(route.request().headers()["x-idempotency-key"]!);
    if (keys.length === 1) await route.abort("connectionreset");
    else await route.fulfill({ json: { status: "completed", message: "Заметка добавлена." } });
  });
  const input = page.getByRole("textbox", { name: "Текст ответа" });
  await input.fill("/note ");
  await expect(page.getByText("/note <текст> — Добавить", { exact: false })).toBeVisible();
  await input.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Формат");
  expect(keys).toHaveLength(0);
  await input.fill("/note private text");
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  expect(keys).toHaveLength(0);
  await input.press("Enter");
  await expect(page.getByRole("alert")).toContainText("прежний ключ");
  await page.reload();
  await expect(input).toHaveValue("/note private text");
  await expect(page.getByText("/note <текст> — Добавить", { exact: false })).toBeVisible();
  await input.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Заметка добавлена" })).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect((await stubLog(request)).filter(item => item.path.endsWith("/send"))).toEqual([]);
  const saved = await page.evaluate(() => Object.values(sessionStorage).join(" "));
  expect(saved).not.toContain("private text");
});

test("mobile command options stay inside the viewport and Escape preserves the draft", async ({ page, consoleErrors }) => {
  void consoleErrors;
  await page.setViewportSize({ width: 320, height: 640 });
  const input = page.getByRole("textbox", { name: "Текст ответа" });
  await input.fill("/n");
  const option = page.getByRole("listbox", { name: "Доступные команды" }).getByRole("option");
  await expect(option).toContainText("/note");
  const box = (await option.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  await input.press("Escape");
  await expect(option).toBeHidden();
  await expect(input).toHaveValue("/n");
  await expect(input).toBeFocused();
});
