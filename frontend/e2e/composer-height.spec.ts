import { test, expect, scenario, SESSION_COOKIE } from "./fixtures";

for (const width of [320, 375]) {
  test(`empty composer ignores wrapped placeholder but grows with text at ${width}px`, async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await page.setViewportSize({ width, height: 568 });
    await scenario(request, { me: "session" });
    await context.addCookies([SESSION_COOKIE]);
    await page.goto("/console/");
    await expect(page.locator("#workspace")).toBeVisible();
    await page.evaluate(() => document.documentElement.style.setProperty("--font-sans", '"DejaVu Sans", sans-serif'));
    await page.getByRole("listbox", { name: "Диалоги" }).getByRole("option", { name: /Анна Смирнова/ }).click();
    const field = page.getByRole("textbox", { name: "Текст ответа" });
    const height = () => page.locator(".composer").evaluate(element => element.getBoundingClientRect().height);
    await expect(field).toBeEditable();
    await expect.poll(height).toBe(52);
    // Make the placeholder wrap regardless of the host's installed fonts.
    await field.evaluate(element => element.setAttribute("placeholder", "Длинная подсказка ".repeat(8)));
    await field.fill("x");
    await field.fill("");
    await expect.poll(height).toBe(52);
    await field.fill("Первая строка\nВторая строка\nТретья строка");
    await expect.poll(height).toBeGreaterThan(52);
    await field.fill("");
    await expect.poll(height).toBe(52);
    await field.fill("Отправить");
    await field.press("Enter");
    await expect(field).toHaveValue("");
    await expect.poll(height).toBe(52);
  });
}
