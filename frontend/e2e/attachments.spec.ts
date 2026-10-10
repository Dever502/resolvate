import type { Page } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, stubLog, test } from "./fixtures";

const preview = (page: Page) => page.getByRole("group", { name: "Выбранное вложение" });
const picker = (page: Page) => page.locator('input[type="file"]');
const input = (page: Page) => page.getByRole("textbox", { name: "Текст ответа" });
type Resources = { decoded: number; closed: number; urls: number };

test.beforeEach(async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await scenario(request, { me: "session" });
  await context.addCookies([SESSION_COOKIE]);
  await page.addInitScript(() => {
    const resources = { decoded: 0, closed: 0, urls: 0 };
    Object.assign(window, { __attachmentResources: resources });
    const createURL = URL.createObjectURL;
    URL.createObjectURL = (blob) => { resources.urls++; return createURL(blob); };
    const decode = window.createImageBitmap.bind(window);
    window.createImageBitmap = (async (file: Blob) => {
      const bitmap = await decode(file);
      resources.decoded++;
      const close = bitmap.close.bind(bitmap);
      bitmap.close = () => { resources.closed++; close(); };
      return bitmap;
    }) as typeof createImageBitmap;
  });
  await page.goto("/console/");
  await page.getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(input(page)).toBeVisible();
});

async function resources(page: Page): Promise<Resources> {
  return page.evaluate(() => (window as unknown as { __attachmentResources: Resources }).__attachmentResources);
}

// Generate real browser-decodable fixtures, with no binary assets or URL/CSP exceptions.
async function photo(page: Page, mimeType = "image/png", width = 600, height = 900) {
  const bytes = await page.evaluate(async ({ mimeType, width, height }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#b3c8db";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#50677e";
    context.fillRect(width / 4, height / 4, width / 2, height / 2);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), mimeType));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, { mimeType, width, height });
  return { name: `photo.${mimeType.split("/")[1]}`, mimeType, buffer: Buffer.from(bytes) };
}

for (const mime of ["image/jpeg", "image/png", "image/webp"]) {
  test(`decodes ${mime} under production CSP without URLs or upload`, async ({ page, request, consoleErrors }) => {
    void consoleErrors;
    const selected = await photo(page, mime);
    await picker(page).setInputFiles(selected);
    const canvas = preview(page).locator("canvas");
    await expect(canvas).toBeVisible();
    const result = await canvas.evaluate((element: HTMLCanvasElement) => ({
      ratio: element.width / element.height,
      alpha: element.getContext("2d")!.getImageData(0, 0, 1, 1).data[3],
    }));
    expect(result.ratio).toBeCloseTo(600 / 900, 2);
    expect(result.alpha).toBe(255);
    expect(await resources(page)).toEqual({ decoded: 1, closed: 1, urls: 0 });
    expect((await stubLog(request)).filter(entry => entry.path.endsWith("/send"))).toEqual([]);
  });
}

test("replacement, removal, per-dialogue draft and send keep attachments in sync", async ({ page, consoleErrors }) => {
  void consoleErrors;
  await input(page).fill("Черновик с фото");
  await picker(page).setInputFiles(await photo(page));
  await expect(preview(page).locator("canvas")).toBeVisible();
  await picker(page).setInputFiles({ name: "terms.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-test") });
  await expect(preview(page)).toContainText("terms.pdf");
  await expect(preview(page).locator("canvas")).toBeHidden();
  await page.getByRole("option", { name: /Борис Петров/ }).click();
  await expect(preview(page)).toBeHidden();
  await picker(page).setInputFiles({ name: "voice.opus", mimeType: "audio/opus", buffer: Buffer.from("OggS") });
  await page.getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(preview(page)).toContainText("terms.pdf");
  await expect(input(page)).toHaveValue("Черновик с фото");
  await page.getByRole("button", { name: "Убрать вложение" }).click();
  await expect(preview(page)).toBeHidden();
  await expect(input(page)).toHaveValue("Черновик с фото");
  await picker(page).setInputFiles(await photo(page));
  await expect(preview(page).locator("canvas")).toBeVisible();
  await input(page).press("Enter");
  await expect(preview(page)).toBeHidden();
  await expect(input(page)).toHaveValue("");
  await page.getByRole("option", { name: /Борис Петров/ }).click();
  await expect(preview(page)).toContainText("voice.opus");
  expect(await resources(page)).toEqual({ decoded: 2, closed: 2, urls: 0 });
});

test("failed send retains the preview and retry sends the same file and key", async ({ page, consoleErrors }) => {
  void consoleErrors;
  const attempts: { key: string | undefined; body: Buffer | null }[] = [];
  await page.route("**/tickets/t1/send", async route => {
    attempts.push({ key: route.request().headers()["x-idempotency-key"], body: route.request().postDataBuffer() });
    if (attempts.length === 1) await route.fulfill({ status: 503, json: { detail: "Попробуйте снова" } });
    else await route.continue();
  });
  await picker(page).setInputFiles(await photo(page));
  await expect(preview(page).locator("canvas")).toBeVisible();
  await input(page).press("Enter");
  await expect(page.getByRole("alert")).toContainText("Попробуйте снова");
  await expect(preview(page).locator("canvas")).toBeVisible();
  await input(page).press("Enter");
  await expect(preview(page)).toBeHidden();
  expect(attempts).toHaveLength(2);
  expect(attempts[0]!.key).toBeTruthy();
  expect(attempts[1]!.key).toBe(attempts[0]!.key);
  for (const attempt of attempts) expect(attempt.body?.includes(Buffer.from('filename="photo.png"'))).toBe(true);
  expect(await resources(page)).toEqual({ decoded: 1, closed: 1, urls: 0 });
});

test("switching dialogues rebuilds only their own photo preview; switching projects drops it", async ({ page, consoleErrors }) => {
  void consoleErrors;
  await picker(page).setInputFiles(await photo(page));
  await expect(preview(page).locator("canvas")).toBeVisible();
  await page.getByRole("option", { name: /Борис Петров/ }).click();
  await expect(preview(page)).toBeHidden();
  await page.getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(preview(page).locator("canvas")).toBeVisible();
  expect(await resources(page)).toEqual({ decoded: 2, closed: 2, urls: 0 });
  await page.getByRole("button", { name: /^Текущий проект/ }).click();
  await page.getByRole("menuitemradio", { name: "Второй проект" }).click();
  await expect(preview(page)).toBeHidden();
  expect(await resources(page)).toEqual({ decoded: 2, closed: 2, urls: 0 });
});

test("document/audio/video cards, invalid images and unsupported formats are safe", async ({ page, consoleErrors }) => {
  void consoleErrors;
  for (const [name, mimeType, label] of [
    ["clip.mp4", "video/mp4", "Видео"], ["clip.mov", "video/quicktime", "Видео"],
    ["document.pdf", "application/pdf", "PDF"], ["voice.ogg", "audio/ogg", "Аудио"],
    ["voice.opus", "audio/opus", "Аудио"], ["drawing.svg", "image/svg+xml", "Формат не поддерживается"],
  ] as const) {
    await picker(page).setInputFiles({ name, mimeType, buffer: Buffer.from("not decoded") });
    await expect(preview(page)).toContainText(name);
    await expect(preview(page)).toContainText(label);
    await expect(preview(page).locator("canvas")).toBeHidden();
  }
  await picker(page).setInputFiles({ name: "broken.png", mimeType: "image/png", buffer: Buffer.from("invalid image") });
  await expect(preview(page)).toContainText("Предпросмотр недоступен");
  await page.getByRole("button", { name: "Убрать вложение" }).click();
  await expect(preview(page)).toBeHidden();
  expect(await resources(page)).toEqual({ decoded: 0, closed: 0, urls: 0 });
});

for (const width of [1280, 375]) {
  test(`compact preview and long names fit ${width}px in both themes`, async ({ page, consoleErrors }, testInfo) => {
    void consoleErrors;
    await page.setViewportSize({ width, height: 812 });
    const selected = await photo(page);
    selected.name = `${"Длинное_название_вложения_".repeat(12)}.png`;
    await picker(page).setInputFiles(selected);
    await expect(preview(page).locator("canvas")).toBeVisible();
    const art = (await preview(page).locator(".attachment-preview-art").boundingBox())!;
    const canvas = (await preview(page).locator("canvas").boundingBox())!;
    expect(canvas.width).toBeLessThanOrEqual(art.width);
    expect(canvas.height).toBeLessThanOrEqual(art.height);
    await expect(input(page)).toBeInViewport();
    await expect(page.getByRole("button", { name: "Убрать вложение" })).toBeInViewport();
    expect((await preview(page).boundingBox())!.height).toBeLessThanOrEqual(90);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await testInfo.attach(`attachment-${width}-${theme}`, { body: await page.screenshot(), contentType: "image/png" });
    }
    expect(await resources(page)).toEqual({ decoded: 1, closed: 1, urls: 0 });
  });
}
