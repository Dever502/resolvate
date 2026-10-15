import { writeFileSync } from "node:fs";
import type { APIRequestContext, BrowserContext, JSHandle, Locator, Page } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, test } from "./fixtures";

// Files dragged onto the open dialogue (components/chat/ConversationPanel.vue, composables/useFileDrop.ts):
// the file picker's own check and attach (chat.attach, lib/attachment.ts), up to five files per reply,
// nothing attached unseen. A drag from the computer is the browser's own events carrying a DataTransfer with
// files: one is built in the page, and its events are dispatched where the pointer would be, in the
// order the browser fires them. Chromium also takes a drag through its own input (hit testing, drop
// effect, default actions). Every test also fails on a CSP violation or a console error.
const CONSOLE = "/console/";
const SEND = "**/console/projects/p1/tickets/t1/send";
const MiB = 1024 * 1024;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const HINT = "Перетащите файлы для прикрепления";
const FULL = "В ответе уже 5 файлов: уберите лишний, чтобы прикрепить другой.";
const UNSUPPORTED = "Этот формат не поддерживается. Можно прикрепить фото JPEG, PNG или WebP, видео MP4 или MOV, PDF или голосовое OGG/Opus.";
const NO_DIALOGUE = "Откройте диалог, чтобы прикрепить файл.";
const SENDING = "Идёт отправка: перетащите файл, когда она закончится.";
const list = (page: Page) => page.getByRole("listbox", { name: "Диалоги" });
const dialogue = (page: Page, name: RegExp) => list(page).getByRole("option", { name });
const panel = (page: Page) => page.locator("#workspace main");
const history = (page: Page) => page.getByRole("region", { name: "Переписка" });
const composer = (page: Page) => page.getByRole("textbox", { name: "Текст ответа" });
const preview = (page: Page) => page.getByRole("group", { name: "Выбранные вложения" });
const remove = (page: Page) => page.getByRole("button", { name: "Убрать вложение" });
// The highlight is decoration, hidden from screen readers; the panel's notice says what a drop did.
const zone = (page: Page) => page.locator(".drop-zone");
const notice = (page: Page) => panel(page).locator(".notice");

interface Dragged {
  /** Zero bytes of `size` (16 by default), or a real PNG for a photo. */
  files?: { name: string; type: string; size?: number; photo?: boolean }[];
  text?: string;
  link?: string;
}
const photo = (name = "photo.png") => ({ name, type: "image/png", photo: true });
const pdf = (name: string, size?: number) => ({ name, type: "application/pdf", size });

/** A DataTransfer as a drag from outside the page brings it: files, or text and a link. */
function transfer(page: Page, dragged: Dragged): Promise<JSHandle<DataTransfer>> {
  return page.evaluateHandle(async ({ files = [], text, link }) => {
    const data = new DataTransfer();
    for (const file of files) {
      let body: BlobPart = new Uint8Array(file.size ?? 16);
      if (file.photo) {
        const canvas = document.createElement("canvas");
        canvas.width = 60;
        canvas.height = 90;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#50677e";
        context.fillRect(0, 0, 60, 90);
        body = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"));
      }
      data.items.add(new File([body], file.name, { type: file.type }));
    }
    if (link !== undefined) data.setData("text/uri-list", link);
    if (text !== undefined) data.setData("text/plain", text);
    return data;
  }, dragged);
}

type DragType = "dragenter" | "dragover" | "dragleave" | "drop" | "dragend";

/** Dispatches a drag event at the element as the browser does; true when the page took it (preventDefault). */
function fire(target: Locator, type: DragType, data: JSHandle<DataTransfer>): Promise<boolean> {
  return target.evaluate((element, { type, data }) => {
    const event = new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: data });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, { type, data });
}

/** The drag comes over the element from outside: it enters, then moves. Both are taken: the browser opens nothing there. */
async function arrive(target: Locator, data: JSHandle<DataTransfer>): Promise<void> {
  expect(await fire(target, "dragenter", data)).toBe(true);
  expect(await fire(target, "dragover", data)).toBe(true);
}

/** A whole drop on the element; the drop is taken too, so the browser does not open the file instead. */
async function dropOn(target: Locator, data: JSHandle<DataTransfer>): Promise<void> {
  await arrive(target, data);
  expect(await fire(target, "drop", data)).toBe(true);
}

async function start(page: Page, context: BrowserContext, request: APIRequestContext): Promise<void> {
  await scenario(request, { me: "session" });
  await context.addCookies([SESSION_COOKIE]);
  await page.goto(CONSOLE);
  await expect(page.locator("#workspace")).toBeVisible();
}

async function openAnna(page: Page): Promise<void> {
  await dialogue(page, /Анна Смирнова/).click();
  await expect(history(page).getByText("И ещё вопрос про оплату")).toBeVisible();
  // The reply box takes input, and a file, once the dialogue's stored draft has been read.
  await expect(composer(page)).toBeEditable();
}

async function chooseProject(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: /^Текущий проект/ }).click();
  await page.getByRole("menuitemradio", { name }).click();
  await expect(page.getByRole("button", { name: /^Текущий проект/ })).toHaveAccessibleName(`Текущий проект ${name}`);
}

/** The dialogue's draft as the page keeps it in IndexedDB: its text and the name of its file. */
function storedDraft(page: Page, ticket: string): Promise<{ text: string; files: string[] } | null> {
  return page.evaluate((ticket) => new Promise((resolve, reject) => {
    const request = indexedDB.open("resolvate-work");
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction("drafts", "readonly").objectStore("drafts").getAll();
      read.onsuccess = () => {
        db.close();
        const row = (read.result as { ticket: string; text: string; files: { name: string }[] }[]).find((item) => item.ticket === ticket);
        resolve(row ? { text: row.text, files: row.files.map((file) => file.name) } : null);
      };
      read.onerror = () => reject(read.error);
    };
    request.onerror = () => reject(request.error);
  }), ticket);
}

test.describe("dropping a file on the open dialogue", () => {
  test("a photo dropped on the history is attached and previewed; the dialogue keeps its layout, the text stays", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await composer(page).fill("Подпись к фото");
    const layout = await Promise.all([history(page).boundingBox(), composer(page).boundingBox()]);
    const data = await transfer(page, { files: [photo()] });
    await arrive(history(page), data);
    await expect(zone(page)).toHaveText(HINT);
    await expect(zone(page)).not.toHaveAttribute("data-refused");
    // Decoration over the panel: the dialogue keeps its place and the pointer goes past it to the history.
    expect(await Promise.all([history(page).boundingBox(), composer(page).boundingBox()])).toEqual(layout);
    await expect(zone(page)).toHaveCSS("pointer-events", "none");
    const { x, y, width, height } = layout[0]!;
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".messages, .drop-zone")?.className,
      { x: x + width / 2, y: y + height / 2 })).toBe("messages");
    expect(await fire(history(page), "drop", data)).toBe(true);
    await expect(zone(page)).toHaveCount(0);
    await expect(preview(page)).toContainText("photo.png");
    await expect(preview(page).locator("canvas")).toBeVisible();
    await expect(composer(page)).toHaveValue("Подпись к фото");
    await expect(notice(page)).toHaveCount(0);
  });

  test("a dropped file is removed and sent as a picked one", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    const bodies: string[] = [];
    await page.route(SEND, async (route) => {
      bodies.push(route.request().postDataBuffer()?.toString("utf8") ?? "");
      await route.continue();
    });
    await dropOn(composer(page), await transfer(page, { files: [pdf("terms.pdf")] }));
    await expect(preview(page)).toContainText("terms.pdf");
    await remove(page).click();
    await expect(preview(page)).toBeHidden();
    await composer(page).fill("Фото заказа");
    await dropOn(history(page), await transfer(page, { files: [photo()] }));
    await expect(preview(page).locator("canvas")).toBeVisible();
    await composer(page).press("Enter");
    await expect(preview(page)).toBeHidden();
    await expect(composer(page)).toHaveValue("");
    const sent = history(page).locator("article.outgoing").last();
    await expect(sent).toContainText("Фото заказа");
    await expect(sent.getByRole("button", { name: "Открыть изображение" })).toBeVisible();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('filename="photo.png"');
  });

  test("unsupported, empty and too large files are refused as from the picker; the attached file and the text stay", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await composer(page).fill("Текст остаётся");
    await dropOn(history(page), await transfer(page, { files: [photo()] }));
    await expect(preview(page)).toContainText("photo.png");
    for (const [file, said] of [
      [{ name: "notes.txt", type: "text/plain" }, UNSUPPORTED],
      [{ name: "drawing.svg", type: "image/svg+xml" }, UNSUPPORTED],
      [pdf("empty.pdf", 0), "Файл пустой. Прикрепите другой файл."],
      [pdf("large.pdf", 20 * MiB + 1), "Файл больше 20 МБ."],
    ] as const) {
      await dropOn(history(page), await transfer(page, { files: [file] }));
      await expect(notice(page)).toHaveText(said);
      await expect(preview(page)).toContainText("photo.png");
      await expect(composer(page)).toHaveValue("Текст остаётся");
    }
    // Exactly 20 MiB is taken.
    await dropOn(history(page), await transfer(page, { files: [pdf("limit.pdf", 20 * MiB)] }));
    await expect(preview(page)).toContainText("limit.pdf");
    await expect(composer(page)).toHaveValue("Текст остаётся");
  });

  test("several files dropped at once go after the attached one, in order; past five the rest are named, then the panel says it is full", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await composer(page).fill("Несколько файлов сразу");
    await dropOn(history(page), await transfer(page, { files: [pdf("terms.pdf")] }));
    const several = await transfer(page, { files: [photo("first.png"), photo("second.png")] });
    await arrive(history(page), several);
    await expect(zone(page)).toHaveText(HINT);
    await expect(zone(page)).not.toHaveAttribute("data-refused");
    expect(await fire(history(page), "drop", several)).toBe(true);
    const cards = preview(page).locator(".attachment-preview-name");
    await expect(cards).toHaveText(["terms.pdf", "first.png", "second.png"]);
    await expect(preview(page).locator("canvas:visible")).toHaveCount(2);
    // Two places left for four files: said while dragged, the first two are taken and the others named.
    const four = await transfer(page, { files: [pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf"), pdf("d.pdf")] });
    await arrive(history(page), four);
    await expect(zone(page)).toHaveText("Прикрепятся 2 из 4: к одному ответу — не больше 5 файлов.");
    expect(await fire(history(page), "drop", four)).toBe(true);
    await expect(cards).toHaveText(["terms.pdf", "first.png", "second.png", "a.pdf", "b.pdf"]);
    await expect(notice(page)).toHaveText("Не прикреплены: «c.pdf» — в ответе уже 5 файлов; «d.pdf» — в ответе уже 5 файлов. К одному ответу можно прикрепить не больше 5 файлов.");
    // Full: refused while dragged, and said if dropped anyway.
    await arrive(history(page), several);
    await expect(zone(page)).toHaveText(FULL);
    await expect(zone(page)).toHaveAttribute("data-refused", "");
    expect(await fire(history(page), "drop", several)).toBe(true);
    await expect(notice(page)).toHaveText(FULL);
    await expect(cards).toHaveCount(5);
    await expect(composer(page)).toHaveValue("Несколько файлов сразу");
  });

  test("text and links are left to the browser: no highlight, nothing taken", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await composer(page).fill("Черновик");
    for (const dragged of [{ text: "Текст из письма" }, { link: "https://example.com/order", text: "https://example.com/order" }]) {
      const data = await transfer(page, dragged);
      for (const target of [composer(page), history(page)]) {
        for (const type of ["dragenter", "dragover", "drop"] as const) expect(await fire(target, type, data)).toBe(false);
        await expect(zone(page)).toHaveCount(0);
      }
    }
    await expect(composer(page)).toHaveValue("Черновик");
    await expect(preview(page)).toBeHidden();
    await expect(notice(page)).toHaveCount(0);
  });

  test("moving between the dialogue's parts keeps one highlight; leaving the panel ends it, the list takes nothing", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    const data = await transfer(page, { files: [photo()] });
    const attach = page.getByRole("button", { name: "Прикрепить файл" });
    const header = page.locator("#customer-open");
    const row = dialogue(page, /Борис Петров/);
    await arrive(history(page), data);
    await expect(zone(page)).toHaveText(HINT);
    // The browser enters the next node before it leaves the previous one; back on a node, it enters it again.
    for (const [entered, left] of [
      [composer(page), history(page)],
      [attach, composer(page)],
      [attach.locator("svg"), attach],
      [attach, attach.locator("svg")],
      [header, attach],
    ] as const) {
      expect(await fire(entered, "dragenter", data)).toBe(true);
      await fire(left, "dragleave", data);
      expect(await fire(entered, "dragover", data)).toBe(true);
      await expect(zone(page)).toHaveCount(1);
      await expect(zone(page)).toHaveText(HINT);
    }
    // Out to the list: its row is entered (the list does not take the drag), then the header is left.
    expect(await fire(row, "dragenter", data)).toBe(false);
    await fire(header, "dragleave", data);
    await expect(zone(page)).toHaveCount(0);
    expect(await fire(row, "dragover", data)).toBe(false);
    expect(await fire(row, "drop", data)).toBe(false);
    await expect(preview(page)).toBeHidden();
    await expect(notice(page)).toHaveCount(0);
  });

  test("a cancelled drag and one leaving the window end the highlight; so does one whose node goes away", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    const data = await transfer(page, { files: [photo()] });
    // Esc, or the pointer out of the window: the browser fires dragleave at the node the drag is over.
    await arrive(history(page), data);
    await expect(zone(page)).toBeVisible();
    await fire(history(page), "dragleave", data);
    await expect(zone(page)).toHaveCount(0);
    // A drag that started in the page ends with dragend.
    await arrive(composer(page), data);
    await expect(zone(page)).toBeVisible();
    await fire(composer(page), "dragend", data);
    await expect(zone(page)).toHaveCount(0);
    await expect(preview(page)).toBeHidden();
    await expect(notice(page)).toHaveCount(0);
    // The node under the drag is removed (the pointer goes past the highlight to the button): its
    // dragleave never reaches the panel, and the next dragover elsewhere ends the highlight.
    await dropOn(history(page), data);
    await arrive(preview(page), data);
    await expect(zone(page)).toBeVisible();
    await remove(page).click();
    await expect(preview(page)).toBeHidden();
    await expect(zone(page)).toBeVisible();
    expect(await fire(dialogue(page, /Борис Петров/), "dragover", data)).toBe(false);
    await expect(zone(page)).toHaveCount(0);
  });

  test("a file dropped while the reply is being sent is refused and said; the reply goes as it was", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    const bodies: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(SEND, async (route) => {
      bodies.push(route.request().postDataBuffer()?.toString("utf8") ?? "");
      await held;
      await route.continue();
    });
    const data = await transfer(page, { files: [photo()] });
    await composer(page).fill("Ответ без вложения");
    await composer(page).press("Enter");
    await expect(composer(page)).toBeDisabled();
    for (const target of [history(page), composer(page)]) {
      await arrive(target, data);
      await expect(zone(page)).toHaveText(SENDING);
      await expect(zone(page)).toHaveAttribute("data-refused", "");
      expect(await fire(target, "drop", data)).toBe(true);
      await expect(zone(page)).toHaveCount(0);
      await expect(notice(page)).toHaveText(SENDING);
      await expect(preview(page)).toBeHidden();
    }
    release();
    await expect(history(page).locator("article.outgoing").last()).toContainText("Ответ без вложения");
    await expect(composer(page)).toHaveValue("");
    await expect(preview(page)).toBeHidden();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("Ответ без вложения");
    expect(bodies[0]).not.toContain("filename=");
    // Once the send is over a file is taken again.
    await dropOn(history(page), data);
    await expect(preview(page)).toContainText("photo.png");
  });

  test("another dialogue opened under the drag: the highlight goes, the file lands in neither unseen", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await composer(page).fill("Черновик Анны");
    const data = await transfer(page, { files: [photo()] });
    await arrive(history(page), data);
    await expect(zone(page)).toHaveText(HINT);
    await dialogue(page, /Борис Петров/).click();
    await expect(page.locator("#customer-open")).toContainText("Борис Петров");
    await expect(zone(page)).toHaveCount(0);
    // Dropped before the drag moved again: refused, attached to neither dialogue.
    expect(await fire(panel(page), "drop", data)).toBe(true);
    await expect(notice(page)).toHaveText("Диалог сменился во время перетаскивания: перетащите файл снова.");
    await expect(composer(page)).toBeEditable();
    await expect(preview(page)).toBeHidden();
    await dialogue(page, /Анна Смирнова/).click();
    await expect(composer(page)).toHaveValue("Черновик Анны");
    await expect(preview(page)).toBeHidden();
    // A drag that moves on over the dialogue shown is that dialogue's.
    await arrive(history(page), data);
    await dialogue(page, /Борис Петров/).click();
    await expect(composer(page)).toBeEditable();
    await expect(zone(page)).toHaveCount(0);
    expect(await fire(history(page), "dragover", data)).toBe(true);
    await expect(zone(page)).toHaveText(HINT);
    expect(await fire(history(page), "drop", data)).toBe(true);
    await expect(preview(page)).toContainText("photo.png");
    await dialogue(page, /Анна Смирнова/).click();
    await expect(composer(page)).toHaveValue("Черновик Анны");
    await expect(preview(page)).toBeHidden();
  });

  test("with no dialogue open the panel takes no file and says why; a dialogue closed under the drag keeps its draft", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await expect(page.getByRole("heading", { name: "Выберите диалог" })).toBeVisible();
    const data = await transfer(page, { files: [photo()] });
    await arrive(panel(page), data);
    await expect(zone(page)).toHaveText(NO_DIALOGUE);
    await expect(zone(page)).toHaveAttribute("data-refused", "");
    expect(await fire(panel(page), "drop", data)).toBe(true);
    await expect(notice(page)).toHaveText(NO_DIALOGUE);
    // Another project closes the dialogue under the drag: the highlight goes, and over the empty
    // panel the drop is refused.
    await openAnna(page);
    await composer(page).fill("Черновик Анны");
    await arrive(history(page), data);
    await expect(zone(page)).toHaveText(HINT);
    await chooseProject(page, "Второй проект");
    await expect(page.getByRole("heading", { name: "Выберите диалог" })).toBeVisible();
    await expect(zone(page)).toHaveCount(0);
    expect(await fire(panel(page), "dragover", data)).toBe(true);
    await expect(zone(page)).toHaveText(NO_DIALOGUE);
    expect(await fire(panel(page), "drop", data)).toBe(true);
    await expect(notice(page)).toHaveText(NO_DIALOGUE);
    await chooseProject(page, "Поддержка");
    await openAnna(page);
    await expect(composer(page)).toHaveValue("Черновик Анны");
    await expect(preview(page)).toBeHidden();
  });

  test("a dialogue that is gone takes no file and says why", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await page.route("**/console/projects/p1/tickets/t2", (route) => route.fulfill({ status: 404, json: { detail: "Диалог не найден." } }));
    await dialogue(page, /Борис Петров/).click();
    await expect(notice(page)).toHaveText("Диалог не найден.");
    // Its draft is read: the reply box is there, only the dialogue is gone.
    await expect(composer(page)).toBeEditable();
    const data = await transfer(page, { files: [photo()] });
    await arrive(history(page), data);
    await expect(zone(page)).toHaveText("Диалог недоступен: прикрепить файл нельзя.");
    await expect(zone(page)).toHaveAttribute("data-refused", "");
    expect(await fire(history(page), "drop", data)).toBe(true);
    await expect(notice(page)).toHaveText("Диалог недоступен: прикрепить файл нельзя.");
    await expect(preview(page)).toBeHidden();
  });

  test("a window open over the workspace takes no file into the dialogue behind it", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await history(page).getByRole("button", { name: "Открыть изображение" }).click();
    const viewer = page.getByRole("dialog", { name: "Просмотр изображения" });
    await expect(viewer).toBeVisible();
    const data = await transfer(page, { files: [photo()] });
    // A real drag goes to the window's backdrop; the panel under it is reached directly here.
    await arrive(panel(page), data);
    await expect(zone(page)).toHaveText("Закройте окно, чтобы прикрепить файл.");
    expect(await fire(panel(page), "drop", data)).toBe(true);
    await expect(notice(page)).toHaveText("Закройте окно, чтобы прикрепить файл.");
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    await expect(preview(page)).toBeHidden();
    await dropOn(history(page), data);
    await expect(preview(page)).toContainText("photo.png");
  });

  test("before the dialogue's draft is read the panel takes no file, as the attach button", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    // The first opening of the browser's storage waits for the test: meanwhile no draft is read.
    await page.addInitScript(() => {
      const open = IDBFactory.prototype.open;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      Object.assign(window, { __openStorage: release });
      IDBFactory.prototype.open = function (this: IDBFactory, ...args: Parameters<IDBFactory["open"]>): IDBOpenDBRequest {
        const waiting: Record<string, unknown> = {};
        void gate.then(() => {
          const real = open.apply(this, args);
          for (const name of ["onupgradeneeded", "onsuccess", "onerror", "onblocked"] as const) {
            real[name] = (event: Event) => (waiting[name] as ((event: Event) => void) | undefined)?.(event);
          }
          Object.defineProperties(waiting, { result: { get: () => real.result }, error: { get: () => real.error } });
        });
        return waiting as unknown as IDBOpenDBRequest;
      };
    });
    await start(page, context, request);
    const data = await transfer(page, { files: [photo()] });
    await dialogue(page, /Анна Смирнова/).click();
    await expect(composer(page)).toHaveAttribute("readonly", "");
    await expect(page.getByRole("button", { name: "Прикрепить файл" })).toBeDisabled();
    await arrive(history(page), data);
    await expect(zone(page)).toHaveText("Черновик диалога ещё загружается: перетащите файл чуть позже.");
    expect(await fire(history(page), "drop", data)).toBe(true);
    await expect(notice(page)).toHaveText("Черновик диалога ещё загружается: перетащите файл чуть позже.");
    await page.evaluate(() => (window as unknown as { __openStorage: () => void }).__openStorage());
    await expect(composer(page)).toBeEditable();
    await expect(preview(page)).toBeHidden();
    await dropOn(history(page), data);
    await expect(preview(page)).toContainText("photo.png");
  });

  test("the draft keeps its text through refused drops; a dropped file is stored with it and comes back after a reload", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await composer(page).fill("Черновик с файлом");
    await dropOn(history(page), await transfer(page, { files: [photo("contract.png")] }));
    await expect(preview(page)).toContainText("contract.png");
    await dropOn(history(page), await transfer(page, { files: [{ name: "notes.txt", type: "text/plain" }] }));
    await expect(notice(page)).toHaveText(UNSUPPORTED);
    await dropOn(history(page), await transfer(page, { files: [photo("scan.png"), { name: "notes.txt", type: "text/plain" }] }));
    await expect(notice(page)).toHaveText("Файл «notes.txt» не прикреплён: формат не поддерживается.");
    await expect(composer(page)).toHaveValue("Черновик с файлом");
    await expect(preview(page).locator(".attachment-preview-name")).toHaveText(["contract.png", "scan.png"]);
    await expect.poll(() => storedDraft(page, "t1")).toEqual({ text: "Черновик с файлом", files: ["contract.png", "scan.png"] });
    await page.reload();
    await expect(composer(page)).toHaveValue("Черновик с файлом");
    await expect(preview(page).locator(".attachment-preview-name")).toHaveText(["contract.png", "scan.png"]);
    await expect(preview(page).locator("canvas")).toHaveCount(2);
    for (const canvas of await preview(page).locator("canvas").all()) await expect(canvas).toBeVisible();
  });

  test.describe("through the browser's own drag input", () => {
    // Skipped before the test's fixtures start: a page never opened has no CSP probe to check.
    test.skip(({ browserName }) => browserName !== "chromium", "Only Chromium lets a test drive its own drag input (CDP Input.dispatchDragEvent).");

    test("the file is taken under the highlight, text goes into the box, a refused drop never comes", async ({ page, context, request, consoleErrors }, testInfo) => {
      void consoleErrors;
      await start(page, context, request);
      await openAnna(page);
      const client = await context.newCDPSession(page);
      const files = (name: string) => {
        const path = testInfo.outputPath(name);
        writeFileSync(path, PNG);
        return { items: [], files: [path] };
      };
      const text = { items: [{ mimeType: "text/plain", data: "Текст из письма" }] };
      /** One step of a drag from the computer at the middle of the element, as the browser gets it from the system. */
      async function input(type: "dragEnter" | "dragOver" | "drop", target: Locator, data: { items: { mimeType: string; data: string }[]; files?: string[] }): Promise<void> {
        const box = (await target.boundingBox())!;
        await client.send("Input.dispatchDragEvent", { type, x: box.x + box.width / 2, y: box.y + box.height / 2, data: { ...data, dragOperationsMask: 1 | 2 | 16 } });
      }
      const url = page.url();
      // The pointer reaches the history through the highlight; the drop is the page's, the tab stays.
      const photo = files("photo.png");
      await input("dragEnter", history(page), photo);
      await input("dragOver", history(page), photo);
      await expect(zone(page)).toHaveText(HINT);
      await input("drop", history(page), photo);
      await expect(preview(page)).toContainText("photo.png");
      await expect(zone(page)).toHaveCount(0);
      expect(page.url()).toBe(url);
      // Text is left to the browser: it goes into the reply box it is dropped on.
      await input("dragEnter", composer(page), text);
      await input("dragOver", composer(page), text);
      await expect(zone(page)).toHaveCount(0);
      await input("drop", composer(page), text);
      await expect(composer(page)).toHaveValue("Текст из письма");
      // While the reply is sent the drop effect is "none": the browser never drops the file, over the
      // history or the disabled reply box, and nothing is attached or opened.
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      await page.route(SEND, async (route) => {
        await held;
        await route.continue();
      });
      await composer(page).press("Enter");
      await expect(composer(page)).toBeDisabled();
      const other = files("other.png");
      for (const target of [history(page), composer(page)]) {
        await input("dragEnter", target, other);
        await input("dragOver", target, other);
        await expect(zone(page)).toHaveText(SENDING);
        await input("drop", target, other);
        await expect(zone(page)).toHaveCount(0);
        // No drop reached the page: it would have said why it refused the file.
        await expect(notice(page)).toHaveCount(0);
        await expect(preview(page)).not.toContainText("other.png");
        expect(page.url()).toBe(url);
      }
      release();
      await expect(history(page).locator("article.outgoing").last()).toContainText("Текст из письма");
      await expect(preview(page)).toBeHidden();
    });
  });

  test("on a phone the system file picker stays", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await page.setViewportSize({ width: 375, height: 812 });
    await start(page, context, request);
    await openAnna(page);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Прикрепить файл" }).click();
    await (await chooser).setFiles({ name: "photo.png", mimeType: "image/png", buffer: PNG });
    await expect(preview(page)).toContainText("photo.png");
    await expect(composer(page)).toBeInViewport();
  });

  for (const width of [1280, 375]) {
    test(`the highlight fits the panel at ${width}px in both themes`, async ({ page, context, request, consoleErrors, attachScreenshot }) => {
      void consoleErrors;
      await page.setViewportSize({ width, height: 812 });
      await start(page, context, request);
      await openAnna(page);
      const data = await transfer(page, { files: [photo()] });
      for (const refused of [false, true]) {
        // A reply that has its five files refuses the drag.
        if (refused) {
          await page.locator('input[type="file"]').setInputFiles(["a", "b", "c", "d", "e"].map((name) => ({ name: `${name}.pdf`, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1") })));
        }
        const dragged = data;
        await arrive(history(page), dragged);
        if (refused) await expect(zone(page)).toHaveAttribute("data-refused", "");
        else await expect(zone(page)).not.toHaveAttribute("data-refused");
        const frame = (await panel(page).boundingBox())!;
        const box = (await zone(page).boundingBox())!;
        const label = (await zone(page).locator(".drop-zone-label").boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(frame.x);
        expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width);
        expect(box.y + box.height).toBeLessThanOrEqual(frame.y + frame.height);
        expect(label.x).toBeGreaterThanOrEqual(box.x);
        expect(label.x + label.width).toBeLessThanOrEqual(box.x + box.width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        for (const theme of ["light", "dark"]) {
          await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
          await attachScreenshot(`drop-${refused ? "refused" : "hint"}-${width}-${theme}`);
        }
        await fire(history(page), "dragleave", dragged);
        await expect(zone(page)).toHaveCount(0);
      }
    });
  }
});
