import type { APIRequestContext, BrowserContext, Locator, Page, Route } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, test } from "./fixtures";

// Photos and the history's place (chat/MessageMedia.vue, chat/MessageList.vue, app.css .image-preview):
// a photo's frame has its size before its thumbnail loads, and the history keeps the operator where
// they were (at the end, or reading above) whatever loads late. Thumbnails are real PNGs drawn in the
// page and held back by the test; every test also fails on a CSP violation or a console error.
const list = (page: Page) => page.getByRole("listbox", { name: "Диалоги" });
const history = (page: Page) => page.getByRole("region", { name: "Переписка" });
const composer = (page: Page) => page.getByRole("textbox", { name: "Текст ответа" });
const photos = (page: Page) => history(page).locator(".image-preview");

async function start(page: Page, context: BrowserContext, request: APIRequestContext): Promise<void> {
  await scenario(request, { me: "session" });
  await context.addCookies([SESSION_COOKIE]);
  await page.goto("/console/");
}

/** A PNG of this size drawn in the page. */
async function png(page: Page, width: number, height: number): Promise<Buffer> {
  return Buffer.from(await page.evaluate(async ({ width, height }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#50677e";
    context.fillRect(0, 0, width, height);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, { width, height }));
}

/** Thumbnails held until released, each with its own picture (or a failure). */
function holdThumbnails(page: Page): { release: (index?: number) => void; served: string[]; answer: (fn: (route: Route, index: number) => Promise<void>) => void } {
  const waiting: (() => void)[] = [];
  const served: string[] = [];
  let respond: (route: Route, index: number) => Promise<void> = async (route) => route.continue();
  void page.route("**/thumbnail", async (route) => {
    const index = served.length;
    served.push(route.request().url());
    await new Promise<void>((resolve) => waiting.push(resolve));
    await respond(route, index);
  });
  return {
    served,
    release: (index?: number) => {
      if (index === undefined) for (const go of waiting.splice(0)) go();
      else waiting[index]?.();
    },
    answer: (fn) => { respond = fn; },
  };
}

/** How far the history is from its end, in px. */
const fromEnd = (page: Page) => history(page).evaluate((element) => Math.round(element.scrollHeight - element.scrollTop - element.clientHeight));
const loaded = (photo: Locator) => photo.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);

/** Sends photos as the operator: the history then ends with them. */
async function sendPhotos(page: Page, files: { name: string; buffer: Buffer }[]): Promise<void> {
  await list(page).getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(composer(page)).toBeEditable();
  await page.locator('input[type="file"]').setInputFiles(files.map((file) => ({ ...file, mimeType: "image/png" })));
  await composer(page).press("Enter");
  await expect(page.getByRole("group", { name: "Выбранные вложения" })).toBeHidden();
}

for (const width of [1280, 375]) {
  test(`after a reload the history stays at its end while late thumbnails load, at ${width} px`, async ({ page, context, request, consoleErrors, browserName }, testInfo) => {
    void consoleErrors;
    await page.setViewportSize({ width, height: 800 });
    await start(page, context, request);
    const portrait = await png(page, 600, 900);
    const landscape = await png(page, 900, 500);
    await sendPhotos(page, [{ name: "portrait.png", buffer: portrait }, { name: "landscape.png", buffer: landscape }]);
    const thumbs = holdThumbnails(page);
    thumbs.answer(async (route, index) => route.fulfill({ contentType: "image/png", body: index % 2 ? landscape : portrait }));
    await page.reload();
    await expect(history(page).locator("article").last()).toBeVisible();
    await expect.poll(() => fromEnd(page)).toBeLessThanOrEqual(1);
    // Before the thumbnails: every photo already has its frame, the same before and after.
    const frames = await photos(page).evaluateAll((items) => items.map((item) => [item.getBoundingClientRect().width, item.getBoundingClientRect().height]));
    for (const [frameWidth, frameHeight] of frames) expect(frameHeight).toBeCloseTo((frameWidth! * 3) / 4, 0);
    if (browserName === "chromium") await history(page).screenshot({ path: testInfo.outputPath(`media-before-${width}.png`) });
    // The two thumbnails come at different times.
    await expect.poll(() => thumbs.served.length).toBeGreaterThanOrEqual(2);
    thumbs.release(0);
    await page.waitForTimeout(250);
    expect(await fromEnd(page)).toBeLessThanOrEqual(1);
    thumbs.release();
    await expect.poll(async () => (await loaded(photos(page).last())) && (await loaded(photos(page).nth(-2)))).toBe(true);
    await expect.poll(() => fromEnd(page)).toBeLessThanOrEqual(1);
    expect(await photos(page).evaluateAll((items) => items.map((item) => [item.getBoundingClientRect().width, item.getBoundingClientRect().height]))).toEqual(frames);
    // Pictures are contained, not stretched or cropped: the drawn box keeps the picture's proportions.
    for (const photo of [photos(page).nth(-2), photos(page).last()]) {
      const fit = await photo.locator("img").evaluate((img: HTMLImageElement) => getComputedStyle(img).objectFit);
      expect(fit).toBe("contain");
    }
    if (browserName === "chromium") await history(page).screenshot({ path: testInfo.outputPath(`media-after-${width}.png`) });
  });
}

test("a thumbnail that fails keeps its frame and its way to the original", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await page.setViewportSize({ width: 1280, height: 800 });
  await start(page, context, request);
  await sendPhotos(page, [{ name: "photo.png", buffer: await png(page, 600, 400) }]);
  const thumbs = holdThumbnails(page);
  thumbs.answer(async (route) => route.fulfill({ status: 410, json: { detail: "Вложение больше не хранится." } }));
  await page.reload();
  await expect(history(page).locator("article").last()).toBeVisible();
  const before = (await photos(page).last().boundingBox())!;
  await expect.poll(() => thumbs.served.length).toBeGreaterThanOrEqual(1);
  thumbs.release();
  await expect(photos(page).last()).toHaveAttribute("data-state", "failed");
  await expect(photos(page).last()).toContainText("Открыть изображение");
  const after = (await photos(page).last().boundingBox())!;
  expect([after.width, after.height]).toEqual([before.width, before.height]);
  await expect.poll(() => fromEnd(page)).toBeLessThanOrEqual(1);
});

test("an operator reading above keeps the message at the top of the view while photos load above and below", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  // A short window: with the reading place near the end, the newest photo is still below the view.
  await page.setViewportSize({ width: 1280, height: 520 });
  await start(page, context, request);
  const big = await png(page, 900, 1200);
  await sendPhotos(page, [{ name: "below.png", buffer: big }]);
  const thumbs = holdThumbnails(page);
  thumbs.answer(async (route) => route.fulfill({ contentType: "image/png", body: big }));
  await page.reload();
  await expect(history(page).locator("article").last()).toBeVisible();
  await expect(photos(page)).toHaveCount(2);
  // The older photo of the history (above) and the sent one (below): scroll so that a text message sits
  // between them at the top of the view.
  const reading = history(page).locator("article").filter({ hasText: "Как подключить тариф?" });
  await reading.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await history(page).evaluate((element) => { element.scrollTop -= 40; });
  const top = async () => {
    const view = (await history(page).boundingBox())!;
    return Math.round((await reading.boundingBox())!.y - view.y);
  };
  const before = await top();
  expect(await fromEnd(page)).toBeGreaterThan(100);
  await expect.poll(() => thumbs.served.length).toBeGreaterThanOrEqual(1);
  thumbs.release();
  // The photo below loads (the older one above too, as far as lazy loading reaches it).
  await expect.poll(() => loaded(photos(page).last())).toBe(true);
  await expect.poll(top).toBe(before);
  expect(await fromEnd(page)).toBeGreaterThan(100);
});

test("a new message while photos load, and another dialogue opened before they do, keep their own places", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await page.setViewportSize({ width: 1280, height: 800 });
  await start(page, context, request);
  const big = await png(page, 900, 1200);
  await sendPhotos(page, [{ name: "photo.png", buffer: big }]);
  const thumbs = holdThumbnails(page);
  thumbs.answer(async (route) => route.fulfill({ contentType: "image/png", body: big }));
  await page.reload();
  await expect(history(page).locator("article").last()).toBeVisible();
  await expect.poll(() => thumbs.served.length).toBeGreaterThanOrEqual(1);
  // A customer writes while the photo is still loading: the history follows, and still after the photo.
  await request.post("/__stub/incoming", { data: { ticket: "t1", text: "Пока грузится фото" } });
  await expect(history(page).getByText("Пока грузится фото")).toBeVisible();
  thumbs.release();
  await expect.poll(() => loaded(photos(page).last())).toBe(true);
  await expect.poll(() => fromEnd(page)).toBeLessThanOrEqual(1);
  await expect(history(page).getByText("Пока грузится фото")).toBeInViewport();

  // Анна again after a reload, her photo held, then Борис before it comes: Борис's history keeps its place.
  const served = thumbs.served.length;
  await page.reload();
  await expect(history(page).locator("article").last()).toBeVisible();
  await expect.poll(() => thumbs.served.length).toBeGreaterThan(served);
  await list(page).getByRole("option", { name: /Борис Петров/ }).click();
  await expect(history(page).getByText("Здравствуйте, нужна помощь")).toBeVisible();
  const place = await history(page).evaluate((element) => element.scrollTop);
  thumbs.release();
  await page.waitForTimeout(300);
  expect(await history(page).evaluate((element) => element.scrollTop)).toBe(place);
});

test("a reply that makes the reply box taller keeps the history at its end, and the sent reply is followed", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await page.setViewportSize({ width: 1280, height: 600 });
  await start(page, context, request);
  await list(page).getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(composer(page)).toBeEditable();
  await expect.poll(() => fromEnd(page)).toBeLessThanOrEqual(1);
  const view = async () => (await history(page).boundingBox())!.height;
  const tall = await view();
  await composer(page).fill("Строка ответа\n".repeat(8));
  // The reply box grew into the history's room; the history is still at its end.
  await expect.poll(view).toBeLessThan(tall - 40);
  await expect.poll(() => fromEnd(page)).toBeLessThanOrEqual(1);
  await composer(page).press("Enter");
  await expect(history(page).locator("article").last()).toContainText("Строка ответа");
  await expect.poll(view).toBe(tall);
  await expect.poll(() => fromEnd(page)).toBeLessThanOrEqual(1);
});

test("text that wraps anew in a narrower window keeps the place: the end stays at the end, the message read above stays put", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await page.setViewportSize({ width: 1280, height: 600 });
  await start(page, context, request);
  await list(page).getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(composer(page)).toBeEditable();
  const send = async (text: string) => {
    await composer(page).fill(text);
    await composer(page).press("Enter");
    await expect(history(page).locator("article").last()).toContainText(text.slice(0, 30));
  };
  // A long message that ends the history: narrower, it takes more lines.
  await send("Подробный ответ про тарифы и оплату, ".repeat(30));
  await expect.poll(() => fromEnd(page)).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 900, height: 600 });
  await expect.poll(() => fromEnd(page)).toBeLessThanOrEqual(1);

  // Reading below the long message: it grows above the place read, which stays where it was.
  for (let index = 1; index <= 8; index++) await send(`Короткий ответ ${index}`);
  const reading = history(page).locator("article").filter({ hasText: "Короткий ответ 2" });
  await reading.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await history(page).evaluate((element) => { element.scrollTop -= 20; });
  const top = async () => {
    const view = (await history(page).boundingBox())!;
    return Math.round((await reading.boundingBox())!.y - view.y);
  };
  const before = await top();
  expect(await fromEnd(page)).toBeGreaterThan(100);
  await page.setViewportSize({ width: 760, height: 600 });
  // To a pixel: the layout is in fractions of one, the place is kept from a whole pixel of shift.
  await expect.poll(async () => Math.abs((await top()) - before)).toBeLessThanOrEqual(1);
  expect(await fromEnd(page)).toBeGreaterThan(100);
});
