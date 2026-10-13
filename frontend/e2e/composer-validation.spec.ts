import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, stubLog, test } from "./fixtures";

// What the composer lets go, checked against the server's rules before the send (lib/attachment.ts):
// 3900 characters, 800 with a file, counted as the server counts them; a supported file of 1 byte to
// 20 MiB. The stub refuses the same as the server, so a text the browser lets through is one it takes.
const MiB = 1024 * 1024;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAAABJRU5ErkJggg==", "base64");
const composer = (page: Page) => page.getByRole("textbox", { name: "Текст ответа" });
const preview = (page: Page) => page.getByRole("group", { name: "Выбранное вложение" });
const picker = (page: Page) => page.locator('input[type="file"]');
const limit = (page: Page) => page.locator(".composer-limit");
const history = (page: Page) => page.getByRole("region", { name: "Переписка" });
const outgoing = (page: Page) => history(page).locator("article.outgoing");

async function start(page: Page, context: BrowserContext, request: APIRequestContext): Promise<void> {
  await scenario(request, { me: "session" });
  await context.addCookies([SESSION_COOKIE]);
  await page.goto("/console/");
  await page.getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(composer(page)).toBeEditable();
}

async function sends(request: APIRequestContext): Promise<number> {
  return (await stubLog(request)).filter((entry) => entry.method === "POST" && entry.path.endsWith("/tickets/t1/send")).length;
}

test("800 characters go with a file, 801 do not: said before the send, the draft stays; without the file 3900 go", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await start(page, context, request);
  const sentBefore = await sends(request);
  await composer(page).fill("я".repeat(801));
  await expect(limit(page)).toHaveText("");
  await picker(page).setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: PNG });
  await expect(preview(page)).toContainText("photo.png");
  // Attaching does not cut the text: it is said to be too long for a reply with a file.
  await expect(composer(page)).toHaveValue("я".repeat(801));
  await expect(composer(page)).toHaveAttribute("aria-invalid", "true");
  await expect(limit(page)).toContainText("С вложением можно отправить не больше 800 символов");
  await expect(limit(page)).toContainText("801 / 800");
  await composer(page).press("Enter");
  await expect(page.getByRole("alert")).toHaveText("С вложением можно отправить не больше 800 символов: сократите текст или уберите вложение. Сейчас 801.");
  await expect(composer(page)).toBeFocused();
  expect(await sends(request)).toBe(sentBefore);
  // The text can be fixed as usual.
  await composer(page).press("Backspace");
  await expect(limit(page)).toHaveText("");
  await expect(composer(page)).not.toHaveAttribute("aria-invalid");
  await composer(page).press("Enter");
  await expect(outgoing(page).last()).toContainText("я".repeat(800));
  await expect(preview(page)).toBeHidden();
  // Without a file the limit is 3900 again.
  await composer(page).fill("я".repeat(3901));
  await expect(limit(page)).toContainText("Можно отправить не больше 3900 символов");
  await composer(page).press("Enter");
  await expect(page.getByRole("alert")).toContainText("Сейчас 3901.");
  await composer(page).press("Backspace");
  await composer(page).press("Enter");
  await expect(composer(page)).toHaveValue("");
  expect(await sends(request)).toBe(sentBefore + 2);
});

test("emoji count once, as the server counts them; removing the file brings the longer limit back", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await start(page, context, request);
  // 3900 emoji are 7800 UTF-16 units: the box takes them all, and so does the server.
  await composer(page).fill("😀".repeat(3900));
  await expect(composer(page)).toHaveValue("😀".repeat(3900));
  await expect(limit(page)).toHaveText("");
  await picker(page).setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: PNG });
  await expect(limit(page)).toContainText("3900 / 800");
  await page.getByRole("button", { name: "Убрать вложение" }).click();
  await expect(limit(page)).toHaveText("");
  await composer(page).press("Enter");
  await expect(composer(page)).toHaveValue("");
  await expect(page.getByRole("alert")).toBeHidden();
});

test("unsupported, empty and too large files are refused before the preview; the attached file and the text stay", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await start(page, context, request);
  await composer(page).fill("Текст остаётся");
  await picker(page).setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: PNG });
  await expect(preview(page)).toContainText("photo.png");
  for (const [file, notice] of [
    [{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("text") }, "Этот формат не поддерживается."],
    [{ name: "empty.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(0) }, "Файл пустой. Прикрепите другой файл."],
    [{ name: "large.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(20 * MiB + 1) }, "Файл больше 20 МБ."],
  ] as const) {
    await picker(page).setInputFiles(file);
    await expect(page.getByRole("alert")).toContainText(notice);
    await expect(preview(page)).toContainText("photo.png");
    await expect(composer(page)).toHaveValue("Текст остаётся");
  }
  // Exactly 20 MiB is still taken.
  await picker(page).setInputFiles({ name: "limit.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(20 * MiB) });
  await expect(preview(page)).toContainText("limit.pdf");
});

test("a file without a type is taken by its extension, one the server refuses by content says why and stays", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await start(page, context, request);
  await picker(page).setInputFiles({ name: "voice.opus", mimeType: "", buffer: Buffer.from("OggS") });
  await expect(preview(page)).toContainText("voice.opus");
  await expect(preview(page)).toContainText("Аудио");
  // The server checks the content: its refusal (4xx on the first request) ends the attempt, the draft stays.
  await page.route("**/console/projects/p1/tickets/t1/send", (route) => route.fulfill({ status: 422, json: { detail: "⚠️ Содержимое файла не соответствует заявленному формату." } }), { times: 1 });
  await composer(page).fill("Голосовое");
  await composer(page).press("Enter");
  await expect(page.getByRole("alert")).toHaveText("⚠️ Содержимое файла не соответствует заявленному формату.");
  await expect(composer(page)).toHaveValue("Голосовое");
  await expect(preview(page)).toContainText("voice.opus");
  await expect(page.getByRole("region", { name: "Отправка с неизвестным результатом" })).toBeHidden();
});
