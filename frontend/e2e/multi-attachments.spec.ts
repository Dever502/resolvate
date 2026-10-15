import type { APIRequestContext, BrowserContext, JSHandle, Locator, Page, Route } from "@playwright/test";
import { PASSWORD, SESSION_COOKIE, expect, scenario, stubLog, test } from "./fixtures";

// Several files in one reply (components/composer/Composer.vue, stores/chat.ts): picked together, added
// one by one, dropped and pasted, five at most; sent one after another, each a message with its own
// idempotency key, the text as the first one's caption. A stop leaves the rest in the draft, a lost
// answer or a reload never sends a file twice. Files come from the browser itself (canvas, File,
// DataTransfer), as a user's would. Every test also fails on a CSP violation or a console error.
const CONSOLE = "/console/";
const SEND = "**/console/projects/p1/tickets/t1/send";
const MiB = 1024 * 1024;
const list = (page: Page) => page.getByRole("listbox", { name: "Диалоги" });
const dialogue = (page: Page, name: RegExp) => list(page).getByRole("option", { name });
const history = (page: Page) => page.getByRole("region", { name: "Переписка" });
const composer = (page: Page) => page.getByRole("textbox", { name: "Текст ответа" });
const tray = (page: Page) => page.getByRole("group", { name: "Выбранные вложения" });
const names = (page: Page) => tray(page).locator(".attachment-preview-name");
const card = (page: Page, name: string) => tray(page).locator(".attachment-preview").filter({ has: page.getByText(name, { exact: true }) });
const remove = (page: Page, name: string) => page.getByRole("button", { name: `Убрать вложение «${name}»`, exact: true });
const picker = (page: Page) => page.locator('input[type="file"]');
const progress = (page: Page) => page.locator(".send-progress");
const attempt = (page: Page) => page.getByRole("region", { name: "Отправка с неизвестным результатом" });
const notice = (page: Page) => page.locator("#workspace main .notice");
const outgoing = (page: Page) => history(page).locator("article.outgoing");

async function start(page: Page, context: BrowserContext, request: APIRequestContext): Promise<void> {
  await scenario(request, { me: "session" });
  await context.addCookies([SESSION_COOKIE]);
  await page.goto(CONSOLE);
  await expect(page.locator("#workspace")).toBeVisible();
}

async function openAnna(page: Page): Promise<void> {
  await dialogue(page, /Анна Смирнова/).click();
  await expect(history(page).getByText("И ещё вопрос про оплату")).toBeVisible();
  // The reply box takes input, and files, once the dialogue's stored draft has been read.
  await expect(composer(page)).toBeEditable();
}

async function chooseProject(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: /^Текущий проект/ }).click();
  await page.getByRole("menuitemradio", { name }).click();
  await expect(page.getByRole("button", { name: /^Текущий проект/ })).toHaveAccessibleName(`Текущий проект ${name}`);
}

/** A real PNG the browser decodes, drawn in the page: no binary fixtures, no URLs for the CSP to refuse. */
async function png(page: Page, name: string, color = "#50677e"): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const bytes = await page.evaluate(async (color) => {
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 80;
    const context = canvas.getContext("2d")!;
    context.fillStyle = color;
    context.fillRect(0, 0, 120, 80);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, color);
  return { name, mimeType: "image/png", buffer: Buffer.from(bytes) };
}
const pdf = (name: string, size = 16) => ({ name, mimeType: "application/pdf", buffer: Buffer.concat([Buffer.from("%PDF-1"), Buffer.alloc(Math.max(0, size - 6))]) });

interface Dragged { name: string; type: string; photo?: boolean }
/** Files as a drag from the computer or a paste brings them: a DataTransfer built in the page. */
function transfer(page: Page, files: Dragged[], text?: string): Promise<JSHandle<DataTransfer>> {
  return page.evaluateHandle(async ({ files, text }) => {
    const data = new DataTransfer();
    for (const file of files) {
      let body: BlobPart = new Uint8Array(16);
      if (file.photo) {
        const canvas = document.createElement("canvas");
        canvas.width = 60;
        canvas.height = 90;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#b3c8db";
        context.fillRect(0, 0, 60, 90);
        body = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), file.type));
      }
      data.items.add(new File([body], file.name, { type: file.type }));
    }
    if (text !== undefined) data.setData("text/plain", text);
    return data;
  }, { files, text });
}

/** A whole drop on the element, as the browser fires it; each event is taken (the browser opens nothing). */
async function drop(target: Locator, data: JSHandle<DataTransfer>): Promise<void> {
  for (const type of ["dragenter", "dragover", "drop"]) {
    expect(await target.evaluate((element, { type, data }) => {
      const event = new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: data });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }, { type, data })).toBe(true);
  }
}

/**
 * A paste into the reply box with this clipboard; true when the page took it instead of the browser.
 * The event carries the DataTransfer itself: Firefox copies only the strings of the init's
 * clipboardData into a constructed event, WebKit none. A real Ctrl+V: "the system clipboard" below.
 */
function paste(page: Page, data: JSHandle<DataTransfer>): Promise<boolean> {
  return composer(page).evaluate((element, data) => {
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, data);
}

interface Seen { key: string; text: string; file: string | null }
/** Every send request as it leaves the page: its key, its text and the name of its file. */
function watchSends(page: Page): Seen[] {
  const seen: Seen[] = [];
  page.on("request", (item) => {
    if (!item.url().endsWith("/tickets/t1/send")) return;
    const body = item.postDataBuffer()?.toString("utf8") ?? "";
    seen.push({
      key: item.headers()["x-idempotency-key"] ?? "",
      text: /name="text"\r\n\r\n([\s\S]*?)\r\n--/.exec(body)?.[1] ?? "",
      file: /filename="([^"]*)"/.exec(body)?.[1] ?? null,
    });
  });
  return seen;
}

async function sendsReceived(request: APIRequestContext): Promise<number> {
  return (await stubLog(request)).filter((entry) => entry.method === "POST" && entry.path.endsWith("/tickets/t1/send")).length;
}

/** What the page keeps of the dialogue's draft and attempt in IndexedDB. */
function stored(page: Page): Promise<{ drafts: { ticket: string; text: string; files: string[] }[]; attempts: { ticket: string; key: string }[] }> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("resolvate-work");
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(["drafts", "attempts"], "readonly");
      const drafts = transaction.objectStore("drafts").getAll();
      const attempts = transaction.objectStore("attempts").getAll();
      transaction.oncomplete = () => {
        db.close();
        resolve({
          drafts: drafts.result.map((row) => ({ ticket: row.ticket, text: row.text, files: (row.files as { name: string }[]).map((file) => file.name) })),
          attempts: attempts.result.map((row) => ({ ticket: row.ticket, key: row.key })),
        });
      };
      transaction.onerror = () => reject(transaction.error);
    };
    request.onerror = () => reject(request.error);
  }));
}

test.describe("adding several files", () => {
  test("three picked together (Ctrl/Cmd in the system picker), then more one by one with the paperclip: in order, each previewed", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await picker(page).setInputFiles([await png(page, "first.png"), pdf("terms.pdf"), await png(page, "second.png", "#a0522d")]);
    await expect(names(page)).toHaveText(["first.png", "terms.pdf", "second.png"]);
    for (const chosen of [pdf("invoice.pdf"), await png(page, "third.png")]) {
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Прикрепить файл" }).click();
      const dialog = await chooser;
      expect(dialog.isMultiple()).toBe(true);
      await dialog.setFiles(chosen);
    }
    await expect(names(page)).toHaveText(["first.png", "terms.pdf", "second.png", "invoice.pdf", "third.png"]);
    await expect(tray(page)).toHaveAccessibleName("Выбранные вложения: 5 из 5");
    // Every photo has its own preview; documents show their kind.
    await expect(tray(page).locator("canvas:visible")).toHaveCount(3);
    for (const name of ["first.png", "second.png", "third.png"]) await expect(card(page, name).locator("canvas")).toBeVisible();
    await expect(card(page, "terms.pdf")).toContainText("PDF");
    expect(await sendsReceived(request)).toBe(0);
  });

  test("picker, drop and Ctrl+V add to the same reply; a paste of text stays text", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await composer(page).fill("Черновик");
    await picker(page).setInputFiles(pdf("picked.pdf"));
    await drop(history(page), await transfer(page, [{ name: "dropped-1.png", type: "image/png", photo: true }, { name: "dropped-2.pdf", type: "application/pdf" }]));
    // A screenshot comes from the clipboard without a name: it gets one with the right extension.
    expect(await paste(page, await transfer(page, [{ name: "", type: "image/png", photo: true }]))).toBe(true);
    await expect(names(page)).toHaveText(["picked.pdf", "dropped-1.png", "dropped-2.pdf", /^clipboard-\d{4}-\d{2}-\d{2}-\d{6}\.png$/]);
    await expect(tray(page).locator(".attachment-preview").last().locator("canvas")).toBeVisible();
    await expect(tray(page).locator(".attachment-preview").last()).toContainText("Изображение");
    // Text, with an image alongside or not, is left to the browser: nothing is attached.
    expect(await paste(page, await transfer(page, [], "https://example.com/order"))).toBe(false);
    expect(await paste(page, await transfer(page, [{ name: "image.png", type: "image/png", photo: true }], "Текст из письма"))).toBe(false);
    await expect(names(page)).toHaveCount(4);
    await expect(composer(page)).toHaveValue("Черновик");
    await expect(notice(page)).toHaveCount(0);
  });

  test("a file removed from the middle; five at most; unsupported and over 20 MiB are named, the others taken", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await picker(page).setInputFiles([pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")]);
    await remove(page, "b.pdf").click();
    await expect(names(page)).toHaveText(["a.pdf", "c.pdf"]);
    // Focus goes to the next file's remove button: the keyboard stays in the list.
    await expect(remove(page, "c.pdf")).toBeFocused();
    await picker(page).setInputFiles([
      pdf("d.pdf"), { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("text") }, pdf("big.pdf", 20 * MiB + 1),
      pdf("e.pdf"), pdf("f.pdf", 20 * MiB), pdf("g.pdf"),
    ]);
    await expect(names(page)).toHaveText(["a.pdf", "c.pdf", "d.pdf", "e.pdf", "f.pdf"]);
    await expect(notice(page)).toHaveText(
      "Не прикреплены: «notes.txt» — формат не поддерживается; «big.pdf» — больше 20 МБ; «g.pdf» — в ответе уже 5 файлов. К одному ответу можно прикрепить не больше 5 файлов.",
    );
    // The same name again is another file, once there is room for it.
    await remove(page, "a.pdf").click();
    await picker(page).setInputFiles(pdf("c.pdf"));
    await expect(names(page)).toHaveText(["c.pdf", "d.pdf", "e.pdf", "f.pdf", "c.pdf"]);
  });
});

test.describe("the system clipboard", () => {
  // Skipped before the test's fixtures start: a page never opened has no CSP probe to check.
  test.skip(({ browserName }) => browserName !== "chromium", "Only Chromium lets a test put an image on the system clipboard (clipboard-write permission).");

  test("Ctrl+V of a screenshot attaches it; Ctrl+V of text types it", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await start(page, context, request);
    await openAnna(page);
    await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 40;
      canvas.height = 30;
      canvas.getContext("2d")!.fillRect(0, 0, 40, 30);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    });
    await composer(page).focus();
    await page.keyboard.press("ControlOrMeta+V");
    await expect(names(page)).toHaveText([/^clipboard-\d{4}-\d{2}-\d{2}-\d{6}\.png$/]);
    await expect(tray(page).locator("canvas")).toBeVisible();
    await expect(composer(page)).toHaveValue("");
    await page.evaluate(() => navigator.clipboard.writeText("Ссылка: https://example.com/order"));
    await page.keyboard.press("ControlOrMeta+V");
    await expect(composer(page)).toHaveValue("Ссылка: https://example.com/order");
    await expect(names(page)).toHaveCount(1);
  });
});

test.describe("sending several files", () => {
  test("one after another, in order, each its own message and key; the text is the first one's caption", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    const seen = watchSends(page);
    const before = await outgoing(page).count();
    // A request waits until the server answered the one before: never two at once.
    let open = 0;
    let most = 0;
    const sendRequest = (item: { url: () => string }) => item.url().endsWith("/tickets/t1/send");
    page.on("request", (item) => {
      if (sendRequest(item)) most = Math.max(most, ++open);
    });
    page.on("requestfinished", (item) => { if (sendRequest(item)) open--; });
    page.on("requestfailed", (item) => { if (sendRequest(item)) open--; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let count = 0;
    await page.route(SEND, async (route) => {
      if (++count === 2) await held;
      await route.continue();
    });
    await composer(page).fill("Документы по заказу");
    await picker(page).setInputFiles([await png(page, "photo.png"), pdf("terms.pdf"), pdf("invoice.pdf")]);
    await composer(page).press("Enter");
    await expect(progress(page)).toContainText("Отправка файла 2 из 3. Принято сервером: 1 из 3.");
    await expect(names(page)).toHaveText(["terms.pdf", "invoice.pdf"]);
    await expect(card(page, "terms.pdf")).toContainText("Отправляется…");
    await expect(card(page, "invoice.pdf")).toContainText("В очереди");
    await expect(remove(page, "terms.pdf")).toBeDisabled();
    await expect(remove(page, "invoice.pdf")).toBeEnabled();
    release();
    await expect(tray(page)).toBeHidden();
    await expect(progress(page)).toBeHidden();
    await expect(composer(page)).toHaveValue("");
    expect(seen.map((item) => item.file)).toEqual(["photo.png", "terms.pdf", "invoice.pdf"]);
    expect(seen.map((item) => item.text)).toEqual(["Документы по заказу", "", ""]);
    expect(new Set(seen.map((item) => item.key)).size).toBe(3);
    expect(most).toBe(1);
    await expect(outgoing(page)).toHaveCount(before + 3);
    await expect(outgoing(page).filter({ hasText: "Документы по заказу" })).toHaveCount(1);
    // One reply, no notice per file.
    await expect(notice(page)).toHaveCount(0);
  });

  test("two of five taken, the third refused: those two are not sent again, the third and the rest stay to go on", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    const seen = watchSends(page);
    const before = await outgoing(page).count();
    await page.route(SEND, async (route) => {
      if (/filename="c\.pdf"/.test(route.request().postDataBuffer()?.toString("utf8") ?? "")) {
        return route.fulfill({ status: 422, json: { detail: "⚠️ Содержимое файла не соответствует заявленному формату." } });
      }
      return route.continue();
    });
    await composer(page).fill("Пять файлов");
    await picker(page).setInputFiles(["a", "b", "c", "d", "e"].map((name) => pdf(`${name}.pdf`)));
    await composer(page).press("Enter");
    await expect(notice(page)).toHaveText("⚠️ Содержимое файла не соответствует заявленному формату.");
    await expect(progress(page)).toHaveText(
      "Отправка остановлена на «c.pdf». Принято сервером: 2 из 5. Неотправленные файлы остались в черновике: «Отправить» продолжит.",
    );
    await expect(names(page)).toHaveText(["c.pdf", "d.pdf", "e.pdf"]);
    await expect(attempt(page)).toBeHidden();
    await expect(composer(page)).toHaveValue("");
    await expect(composer(page)).toBeFocused();
    await expect(outgoing(page)).toHaveCount(before + 2);
    // The operator removes the file the server refused and goes on with the rest.
    await remove(page, "c.pdf").click();
    await composer(page).press("Enter");
    await expect(tray(page)).toBeHidden();
    await expect(progress(page)).toBeHidden();
    expect(seen.map((item) => item.file)).toEqual(["a.pdf", "b.pdf", "c.pdf", "d.pdf", "e.pdf"]);
    expect(seen.map((item) => item.text)).toEqual(["Пять файлов", "", "", "", ""]);
    await expect(outgoing(page)).toHaveCount(before + 4);
    expect(await sendsReceived(request)).toBe(4);
  });

  test("the answer to the third file is lost: Send goes on under its key, nothing is saved twice", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    const seen = watchSends(page);
    const before = await outgoing(page).count();
    // The history waits: the lost one is settled by the retry, not by a refresh showing it saved.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/console/projects/p1/tickets/t1/sync", async (route) => {
      await held;
      await route.continue();
    });
    // The server saves the third file's message, its answer never reaches the browser.
    await request.post("/__stub/lose-answer", { data: { file: "c.pdf" } });
    await picker(page).setInputFiles(["a", "b", "c", "d", "e"].map((name) => pdf(`${name}.pdf`)));
    await composer(page).press("Enter");
    await expect(attempt(page)).toContainText("Результат отправки неизвестен.");
    await expect(attempt(page)).toContainText("c.pdf");
    await expect(progress(page)).toContainText("Отправка остановлена на «c.pdf». Принято сервером: 2 из 5.");
    await expect(names(page)).toHaveText(["c.pdf", "d.pdf", "e.pdf"]);
    await expect(card(page, "c.pdf")).toContainText("Результат неизвестен");
    // The draft begins with the same file: Send sends it again under its key, then the rest.
    await composer(page).press("Enter");
    await expect(tray(page)).toBeHidden();
    await expect(attempt(page)).toBeHidden();
    await expect(progress(page)).toBeHidden();
    expect(seen.map((item) => item.file)).toEqual(["a.pdf", "b.pdf", "c.pdf", "c.pdf", "d.pdf", "e.pdf"]);
    expect(seen[3]!.key).toBe(seen[2]!.key);
    expect(new Set(seen.map((item) => item.key)).size).toBe(5);
    release();
    await expect(outgoing(page)).toHaveCount(before + 5);
    expect(await sendsReceived(request)).toBe(6);
  });
});

test.describe("reloads, dialogues and accounts", () => {
  test("a reload keeps the text, the files in their order and their previews; nothing is sent", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await composer(page).fill("Три файла");
    await picker(page).setInputFiles([await png(page, "a.png"), pdf("b.pdf"), await png(page, "c.png", "#a0522d")]);
    await expect.poll(async () => (await stored(page)).drafts).toEqual([{ ticket: "t1", text: "Три файла", files: ["a.png", "b.pdf", "c.png"] }]);
    await page.reload();
    await expect(composer(page)).toHaveValue("Три файла");
    await expect(names(page)).toHaveText(["a.png", "b.pdf", "c.png"]);
    for (const name of ["a.png", "c.png"]) await expect(card(page, name).locator("canvas")).toBeVisible();
    expect(await sendsReceived(request)).toBe(0);
  });

  test("a reload while the files go: those taken stay sent, the one on its way is unknown with its key, the rest stay", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    const keys: string[] = [];
    page.on("request", (item) => { if (item.url().endsWith("/tickets/t1/send")) keys.push(item.headers()["x-idempotency-key"] ?? ""); });
    const before = await outgoing(page).count();
    let count = 0;
    // The second request never reaches the server.
    await page.route(SEND, async (route) => (++count === 2 ? undefined : route.continue()));
    await composer(page).fill("Подпись");
    await picker(page).setInputFiles(["a", "b", "c"].map((name) => pdf(`${name}.pdf`)));
    await composer(page).press("Enter");
    await expect.poll(() => keys.length).toBe(2);
    await expect.poll(async () => (await stored(page)).attempts).toEqual([{ ticket: "t1", key: keys[1] }]);
    await expect.poll(async () => (await stored(page)).drafts).toEqual([{ ticket: "t1", text: "", files: ["b.pdf", "c.pdf"] }]);
    // The request cut off by the reload stays held: it never reaches the server.
    await page.reload();
    await expect(attempt(page)).toContainText("Ответ сервера не получен: страница обновилась во время отправки или отправка идёт в другой вкладке.");
    await expect(attempt(page)).toContainText("b.pdf");
    await expect(names(page)).toHaveText(["b.pdf", "c.pdf"]);
    await expect(card(page, "b.pdf")).toContainText("Результат неизвестен");
    await expect(composer(page)).toHaveValue("");
    await expect(outgoing(page)).toHaveCount(before + 1);
    // Nothing goes by itself.
    expect(await sendsReceived(request)).toBe(1);
    await composer(page).press("Enter");
    await expect(tray(page)).toBeHidden();
    await expect(attempt(page)).toBeHidden();
    expect(keys).toEqual([keys[0], keys[1], keys[1], keys[3]]);
    expect(new Set(keys).size).toBe(3);
    await expect(outgoing(page)).toHaveCount(before + 3);
    await expect.poll(async () => await stored(page)).toEqual({ drafts: [], attempts: [] });
  });

  test("dialogues and projects keep their own files; another account sees none of them", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await picker(page).setInputFiles([pdf("anna-1.pdf"), pdf("anna-2.pdf")]);
    await dialogue(page, /Борис Петров/).click();
    await expect(composer(page)).toBeEditable();
    await expect(tray(page)).toBeHidden();
    await picker(page).setInputFiles(pdf("boris.pdf"));
    await expect(names(page)).toHaveText(["boris.pdf"]);
    await chooseProject(page, "Второй проект");
    await dialogue(page, /Григорий из второго/).click();
    await expect(composer(page)).toBeEditable();
    await expect(tray(page)).toBeHidden();
    await picker(page).setInputFiles(pdf("grigory.pdf"));
    await expect(names(page)).toHaveText(["grigory.pdf"]);
    await chooseProject(page, "Поддержка");
    await openAnna(page);
    await expect(names(page)).toHaveText(["anna-1.pdf", "anna-2.pdf"]);
    await page.reload();
    await expect(names(page)).toHaveText(["anna-1.pdf", "anna-2.pdf"]);
    await dialogue(page, /Борис Петров/).click();
    await expect(names(page)).toHaveText(["boris.pdf"]);
    await chooseProject(page, "Второй проект");
    await dialogue(page, /Григорий из второго/).click();
    await expect(names(page)).toHaveText(["grigory.pdf"]);
    await chooseProject(page, "Поддержка");

    // The session ends on the server; another operator signs in on this device.
    await page.route("**/console/projects/p1/tickets/t2", (route) => route.fulfill({ status: 401, json: { detail: "Войдите в панель." } }), { times: 1 });
    await dialogue(page, /Борис Петров/).click();
    await expect(page.locator("#login-screen")).toBeVisible();
    await page.locator('input[name="login"]').fill("irina");
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByRole("button", { name: "Войти" }).click();
    await openAnna(page);
    await expect(tray(page)).toBeHidden();
    await page.getByRole("button", { name: /^Меню аккаунта/ }).click();
    await page.getByRole("menuitem", { name: "Выйти" }).click();
    await expect(page.locator("#login-screen")).toBeVisible();
    await page.locator('input[name="login"]').fill("operator");
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByRole("button", { name: "Войти" }).click();
    await openAnna(page);
    await expect(names(page)).toHaveText(["anna-1.pdf", "anna-2.pdf"]);
  });
});

for (const width of [1280, 375]) {
  test(`the list of files at ${width}px: keyboard, 44×44 remove buttons, the box in view, no page overflow`, async ({ page, context, request, consoleErrors, attachScreenshot, browserName }, testInfo) => {
    void consoleErrors;
    await page.setViewportSize({ width, height: 812 });
    await start(page, context, request);
    await openAnna(page);
    await composer(page).fill("Фото и документы по заказу");
    await picker(page).setInputFiles([
      await png(page, "photo.png"), pdf(`${"Очень_длинное_название_договора_".repeat(4)}.pdf`), await png(page, "screenshot.png", "#a0522d"),
      pdf("invoice.pdf"), await png(page, "receipt.png", "#2f6f4f"),
    ]);
    await expect(names(page)).toHaveCount(5);
    const list = tray(page).locator(".attachment-list");
    for (const button of await tray(page).locator(".attachment-preview-remove").all()) {
      await button.scrollIntoViewIfNeeded();
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    // A long name is cut with an ellipsis inside its card.
    const long = tray(page).locator(".attachment-preview-name").nth(1);
    expect(await long.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(composer(page)).toBeInViewport();
    const height = (await list.boundingBox())!.height;
    if (width < 700) {
      // A phone: one row (and its scrollbar, where the browser shows one) that scrolls sideways.
      expect(height).toBeLessThanOrEqual(80);
      expect(await list.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    } else {
      // Two rows at most, the rest scrolls.
      expect(height).toBeLessThanOrEqual(124);
    }
    // The keyboard goes from one remove button to the next.
    await remove(page, "photo.png").focus();
    await page.keyboard.press("Tab");
    await expect(tray(page).locator(".attachment-preview-remove").nth(1)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(names(page)).toHaveCount(4);
    await expect(remove(page, "screenshot.png")).toBeFocused();
    await page.keyboard.press("Space");
    await expect(names(page)).toHaveText(["photo.png", "invoice.pdf", "receipt.png"]);
    await expect(remove(page, "invoice.pdf")).toBeFocused();
    await picker(page).setInputFiles([pdf("terms.pdf"), await png(page, "screenshot.png", "#a0522d")]);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      await attachScreenshot(`tray-${width}-${theme}`);
      if (browserName === "chromium") await page.screenshot({ path: testInfo.outputPath(`tray-${width}-${theme}.png`) });
    }
    // While the files go: the progress line and each file's state.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(SEND, async (route) => {
      await held;
      await route.continue();
    });
    await composer(page).press("Enter");
    await expect(progress(page)).toContainText("Отправка файла 1 из 5");
    await expect(page.evaluate(() => document.documentElement.scrollWidth)).resolves.toBeLessThanOrEqual(width);
    await attachScreenshot(`sending-${width}`);
    if (browserName === "chromium") await page.screenshot({ path: testInfo.outputPath(`sending-${width}.png`) });
    await progress(page).getByRole("button", { name: "Остановить" }).click();
    release();
    await expect(progress(page)).toContainText("Отправка остановлена. Принято сервером: 1 из 5.");
    await expect(names(page)).toHaveCount(4);
    if (browserName === "chromium") await page.screenshot({ path: testInfo.outputPath(`stopped-${width}.png`) });
  });
}
