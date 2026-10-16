import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { PASSWORD, SESSION_COOKIE, expect, scenario, stubLog, test } from "./fixtures";

// The tab's place, drafts and send attempts across real reloads (lib/navigation.ts, lib/workStore.ts,
// stores/chat.ts, stores/workspace.ts). The browser's own IndexedDB is read and, for broken records,
// written straight from the page. Every test also fails on a CSP violation or a console error.
const CONSOLE = "/console/";
const SEND = "**/console/projects/p1/tickets/t1/send";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const list = (page: Page) => page.getByRole("listbox", { name: "Диалоги" });
const history = (page: Page) => page.getByRole("region", { name: "Переписка" });
const composer = (page: Page) => page.getByRole("textbox", { name: "Текст ответа" });
const project = (page: Page) => page.getByRole("button", { name: /^Текущий проект/ });
const preview = (page: Page) => page.getByRole("group", { name: "Выбранные вложения" });
const attempt = (page: Page) => page.getByRole("region", { name: "Отправка с неизвестным результатом" });
const outgoing = (page: Page, text: string) => history(page).locator("article.outgoing").filter({ hasText: text });
const dialogue = (page: Page, name: RegExp) => list(page).getByRole("option", { name });

async function start(page: Page, context: BrowserContext, request: APIRequestContext): Promise<void> {
  await scenario(request, { me: "session" });
  await context.addCookies([SESSION_COOKIE]);
  await page.goto(CONSOLE);
  await expect(page.locator("#workspace")).toBeVisible();
}

async function openAnna(page: Page): Promise<void> {
  await dialogue(page, /Анна Смирнова/).click();
  await expect(history(page).getByText("И ещё вопрос про оплату")).toBeVisible();
  // The reply box takes input once the dialogue's stored draft has been read.
  await expect(composer(page)).toBeEditable();
}

async function chooseProject(page: Page, name: string): Promise<void> {
  await project(page).click();
  await page.getByRole("menuitemradio", { name }).click();
  await expect(project(page)).toHaveAccessibleName(`Текущий проект ${name}`);
}

interface Stored {
  drafts: { project: string; ticket: string; account: string; text: string; files: string[]; lostFiles: string[] }[];
  attempts: { project: string; ticket: string; key: string; state: string; text: string }[];
}

/** What the page keeps in its IndexedDB (opened with the same schema, so a missing one is not broken). */
function stored(page: Page): Promise<Stored> {
  return page.evaluate(() => new Promise<Stored>((resolve, reject) => {
    const request = indexedDB.open("resolvate-work", 2);
    request.onupgradeneeded = () => {
      for (const name of ["drafts", "attempts"]) request.result.createObjectStore(name, { keyPath: ["account", "project", "ticket"] });
      request.result.createObjectStore("draftFiles", { keyPath: ["account", "project", "ticket", "id"] });
    };
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(["drafts", "attempts"], "readonly");
      const drafts = transaction.objectStore("drafts").getAll();
      const attempts = transaction.objectStore("attempts").getAll();
      transaction.oncomplete = () => {
        db.close();
        resolve({
          drafts: drafts.result.map((item) => ({
            project: item.project, ticket: item.ticket, account: item.account, text: item.text,
            files: (item.files as { name: string }[]).map((file) => file.name), lostFiles: item.lostFiles,
          })),
          attempts: attempts.result.map((item) => ({ project: item.project, ticket: item.ticket, key: item.key, state: item.state, text: item.text })),
        });
      };
      transaction.onerror = () => reject(transaction.error);
    };
    request.onerror = () => reject(request.error);
  }));
}

/** Puts a raw record into the page's IndexedDB, as an older or broken console would have left it. */
function inject(page: Page, store: "drafts" | "attempts", record: Record<string, unknown>): Promise<void> {
  return page.evaluate(({ store, record }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("resolvate-work", 2);
    request.onupgradeneeded = () => {
      for (const name of ["drafts", "attempts"]) request.result.createObjectStore(name, { keyPath: ["account", "project", "ticket"] });
      request.result.createObjectStore("draftFiles", { keyPath: ["account", "project", "ticket", "id"] });
    };
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(store, "readwrite");
      transaction.objectStore(store).put(record);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
    request.onerror = () => reject(request.error);
  }), { store, record });
}

const draftOf = async (page: Page, ticket: string) => (await stored(page)).drafts.find((item) => item.ticket === ticket) ?? null;

test.describe("the tab's place", () => {
  test("project and dialogue come back after a reload, without a detour through the first project", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await chooseProject(page, "Второй проект");
    await dialogue(page, /Григорий из второго/).click();
    await expect(page.getByRole("region", { name: "Диалог" })).toBeVisible();
    const reloaded = Date.now();
    await page.reload();
    await expect(project(page)).toHaveAccessibleName("Текущий проект Второй проект");
    await expect(dialogue(page, /Григорий из второго/)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("region", { name: "Диалог" })).toBeVisible();
    // The first project was never loaded on the way.
    const after = (await stubLog(request)).filter((entry) => entry.at >= reloaded);
    expect(after.filter((entry) => /^\/console\/projects\/p1\/(tickets|folders|events)/.test(entry.path))).toEqual([]);
  });

  test("without an open dialogue none is opened after a reload", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await page.reload();
    await expect(project(page)).toHaveAccessibleName("Текущий проект Поддержка");
    await expect(page.getByRole("heading", { name: "Выберите диалог" })).toBeVisible();
    await expect(list(page).getByRole("option", { selected: true })).toHaveCount(0);
  });

  test("a project no longer available falls back to the first one and says so", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await chooseProject(page, "Второй проект");
    await page.route("**/console/projects", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const projects = (await response.json()) as { id: string }[];
      return route.fulfill({ response, json: projects.filter((item) => item.id !== "p2") });
    });
    await page.reload();
    await expect(project(page)).toHaveAccessibleName("Текущий проект Поддержка");
    await expect(page.getByRole("alert")).toHaveText("Проект, открытый до обновления страницы, больше недоступен.");
    // Drain intercepted refreshes before closing the context: WebKit may still
    // have a route.fetch in flight after the visible state has settled.
    await page.unrouteAll({ behavior: "wait" });
  });

  test("a dialogue gone or forbidden leaves the list, says so, and keeps its draft", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await dialogue(page, /Борис Петров/).click();
    await composer(page).fill("Черновик для Бориса");
    await expect.poll(async () => (await draftOf(page, "t2"))?.text).toBe("Черновик для Бориса");
    await page.route("**/console/projects/p1/tickets/t2", (route) => route.fulfill({ status: 404, json: { detail: "Диалог не найден." } }));
    await page.reload();
    await expect(page.getByRole("alert")).toHaveText("Диалог, открытый до обновления страницы, недоступен: он удалён или доступ к нему закрыт.");
    await expect(page.getByRole("region", { name: "Диалог" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Выберите диалог" })).toBeVisible();
    await page.unroute("**/console/projects/p1/tickets/t2");
    await dialogue(page, /Борис Петров/).click();
    await expect(composer(page)).toHaveValue("Черновик для Бориса");
    await expect(composer(page)).toBeFocused();
  });

  test("a passing failure keeps the dialogue open with its draft", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await composer(page).fill("Черновик для Анны");
    await expect.poll(async () => (await draftOf(page, "t1"))?.text).toBe("Черновик для Анны");
    await page.route("**/console/projects/p1/tickets/t1", (route) => route.fulfill({ status: 503, json: { detail: "Сервис временно недоступен." } }), { times: 1 });
    await page.reload();
    await expect(page.getByRole("region", { name: "Диалог" })).toBeVisible();
    await expect(composer(page)).toHaveValue("Черновик для Анны");
    await expect(page.getByText("Диалог, открытый до обновления страницы, недоступен", { exact: false })).toHaveCount(0);
  });

  test("on a phone the dialogue screen comes back, not the list", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await page.setViewportSize({ width: 375, height: 812 });
    await start(page, context, request);
    await openAnna(page);
    await page.reload();
    await expect(history(page).getByText("И ещё вопрос про оплату")).toBeVisible();
    await expect(composer(page)).toBeVisible();
    await expect(list(page)).toBeHidden();
  });

  test("a link is followed once: it leaves the address, and a reload restores the tab's own place", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await scenario(request, { me: "session" });
    await context.addCookies([SESSION_COOKIE]);
    const opened = Date.now();
    await page.goto(`${CONSOLE}?project=p2&ticket=t4`);
    await expect(project(page)).toHaveAccessibleName("Текущий проект Второй проект");
    await expect(dialogue(page, /Григорий из второго/)).toHaveAttribute("aria-selected", "true");
    expect(new URL(page.url()).search).toBe("");
    // The link's project came first: the first project was never loaded on the way.
    const log = (await stubLog(request)).filter((entry) => entry.at >= opened);
    expect(log.filter((entry) => /^\/console\/projects\/p1\/(tickets|folders|events)/.test(entry.path))).toEqual([]);
    await chooseProject(page, "Поддержка");
    await openAnna(page);
    await page.reload();
    await expect(project(page)).toHaveAccessibleName("Текущий проект Поддержка");
    await expect(dialogue(page, /Анна Смирнова/)).toHaveAttribute("aria-selected", "true");
  });

  test("after signing in again without a reload the tab's place is still followed", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    // The session ends on the server: the next request answers 401.
    await page.route("**/console/projects/p1/tickets/t2", (route) => route.fulfill({ status: 401, json: { detail: "Войдите в панель." } }), { times: 1 });
    await dialogue(page, /Борис Петров/).click();
    await expect(page.locator("#login-screen")).toBeVisible();
    await page.locator('input[name="login"]').fill("operator");
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByRole("button", { name: "Войти" }).click();
    await openAnna(page);
    await page.reload();
    await expect(dialogue(page, /Анна Смирнова/)).toHaveAttribute("aria-selected", "true");
  });

  test("two tabs keep their own dialogues", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    const second = await context.newPage();
    await second.goto(CONSOLE);
    await dialogue(second, /Борис Петров/).click();
    await expect(second.getByRole("region", { name: "Диалог" })).toBeVisible();
    await page.reload();
    await second.reload();
    await expect(dialogue(page, /Анна Смирнова/)).toHaveAttribute("aria-selected", "true");
    await expect(dialogue(second, /Борис Петров/)).toHaveAttribute("aria-selected", "true");
    await second.close();
  });
});

test.describe("drafts", () => {
  test("text and a photo survive a reload; a removed photo does not come back", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await composer(page).fill("Посмотрите фото");
    await page.locator('input[type="file"]').setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: PNG });
    await expect(preview(page)).toContainText("photo.png");
    await expect.poll(async () => await draftOf(page, "t1")).toMatchObject({ text: "Посмотрите фото", files: ["photo.png"] });
    await page.reload();
    await expect(composer(page)).toHaveValue("Посмотрите фото");
    await expect(preview(page)).toContainText("photo.png");
    await expect(preview(page).locator("canvas")).toBeVisible();

    await page.getByRole("button", { name: "Убрать вложение" }).click();
    await expect.poll(async () => (await draftOf(page, "t1"))?.files).toEqual([]);
    await page.reload();
    await expect(composer(page)).toHaveValue("Посмотрите фото");
    await expect(preview(page)).toBeHidden();
  });

  test("text typed just before a reload is kept", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    // No pause for the delayed write: the page writes the draft as it is left.
    await composer(page).fill("Набрано перед обновлением");
    await page.reload();
    await expect(composer(page)).toHaveValue("Набрано перед обновлением");
  });

  test("drafts of several dialogues and projects stay apart and survive project switches", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await composer(page).fill("Для Анны");
    await dialogue(page, /Борис Петров/).click();
    await composer(page).fill("Для Бориса");
    await chooseProject(page, "Второй проект");
    await dialogue(page, /Григорий из второго/).click();
    await composer(page).fill("Для Григория");
    await chooseProject(page, "Поддержка");
    await openAnna(page);
    await expect(composer(page)).toHaveValue("Для Анны");
    await page.reload();
    await expect(composer(page)).toHaveValue("Для Анны");
    await dialogue(page, /Борис Петров/).click();
    await expect(composer(page)).toHaveValue("Для Бориса");
    await chooseProject(page, "Второй проект");
    await dialogue(page, /Григорий из второго/).click();
    await expect(composer(page)).toHaveValue("Для Григория");
  });

  test("of fast typing the last version is kept; a sent draft does not come back", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await composer(page).pressSequentially("Быстрый ввод", { delay: 15 });
    await expect.poll(async () => (await draftOf(page, "t1"))?.text).toBe("Быстрый ввод");
    await page.reload();
    await expect(composer(page)).toHaveValue("Быстрый ввод");
    await composer(page).press("Enter");
    await expect(outgoing(page, "Быстрый ввод")).toHaveCount(1);
    await expect.poll(async () => await draftOf(page, "t1")).toBeNull();
    await page.reload();
    await expect(composer(page)).toHaveValue("");
  });
});

test.describe("send attempts", () => {
  test("a reload while the send runs: the attempt comes back unknown, nothing is sent by itself, the retry keeps its key", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    const keys: string[] = [];
    page.on("request", (item) => { if (item.url().endsWith("/tickets/t1/send")) keys.push(item.headers()["x-idempotency-key"] ?? ""); });
    await page.route(SEND, () => undefined, { times: 1 });
    await composer(page).fill("Ответ до перезагрузки");
    await composer(page).press("Enter");
    await expect.poll(() => keys.length).toBe(1);
    await expect.poll(async () => (await stored(page)).attempts).toEqual([
      expect.objectContaining({ ticket: "t1", key: keys[0], text: "Ответ до перезагрузки" }),
    ]);
    await page.reload();
    await expect(attempt(page)).toContainText("Ответ сервера не получен: страница обновилась во время отправки или отправка идёт в другой вкладке.");
    await expect(attempt(page)).toContainText("Ответ до перезагрузки");
    expect((await stubLog(request)).filter((entry) => entry.path.endsWith("/tickets/t1/send"))).toEqual([]);
    // A new draft does not change the attempt.
    await composer(page).fill("Другой текст");
    await attempt(page).getByRole("button", { name: "Повторить отправку" }).click();
    await expect(attempt(page)).toBeHidden();
    await expect(outgoing(page, "Ответ до перезагрузки")).toHaveCount(1);
    expect(keys).toEqual([keys[0], keys[0]]);
    await expect(composer(page)).toHaveValue("Другой текст");
    await expect.poll(async () => (await stored(page)).attempts).toEqual([]);
  });

  test("a photo's send cut off by a reload: Enter sends the same attempt again, then the draft is empty", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    const keys: string[] = [];
    page.on("request", (item) => { if (item.url().endsWith("/tickets/t1/send")) keys.push(item.headers()["x-idempotency-key"] ?? ""); });
    await page.route(SEND, () => undefined, { times: 1 });
    await composer(page).fill("Фото договора");
    await page.locator('input[type="file"]').setInputFiles({ name: "contract.png", mimeType: "image/png", buffer: PNG });
    await expect(preview(page)).toContainText("contract.png");
    await composer(page).press("Enter");
    await expect.poll(() => keys.length).toBe(1);
    await expect.poll(async () => (await stored(page)).attempts.length).toBe(1);
    await expect.poll(async () => (await draftOf(page, "t1"))?.files).toEqual(["contract.png"]);
    await page.reload();
    await expect(attempt(page)).toContainText("Фото договора");
    await expect(preview(page)).toContainText("contract.png");
    // The draft is unchanged: the photo read back is the same file, so Enter retries under the same key.
    await composer(page).press("Enter");
    await expect(attempt(page)).toBeHidden();
    await expect(outgoing(page, "Фото договора")).toHaveCount(1);
    expect(keys).toEqual([keys[0], keys[0]]);
    await expect(composer(page)).toHaveValue("");
    await expect(preview(page)).toBeHidden();
    await expect.poll(async () => await stored(page)).toEqual({ drafts: [], attempts: [] });
  });

  test("saved by the server, its answer lost, then a reload: the history settles the attempt", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await page.route(SEND, async (route) => {
      await route.fetch();
      // The answer never reaches the page.
    }, { times: 1 });
    await composer(page).fill("Сохранён на сервере");
    await composer(page).press("Enter");
    await expect.poll(async () => (await stored(page)).attempts.length).toBe(1);
    await expect.poll(async () => (await stubLog(request)).filter((entry) => entry.path.endsWith("/tickets/t1/send")).length).toBe(1);
    await page.reload();
    await expect(outgoing(page, "Сохранён на сервере")).toHaveCount(1);
    await expect(attempt(page)).toBeHidden();
    await expect(page.getByRole("alert")).toHaveText("Сообщение из отправки с неизвестным результатом есть в истории: сервер его принял.");
    await expect.poll(async () => (await stored(page)).attempts).toEqual([]);
    await expect(composer(page)).toHaveValue("");
    expect((await stubLog(request)).filter((entry) => entry.path.endsWith("/tickets/t1/send"))).toHaveLength(1);
  });

  test("an accepted send whose local record outlived it is settled by the history after a reload", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    let key = "";
    page.on("request", (item) => { if (item.url().endsWith("/tickets/t1/send")) key = item.headers()["x-idempotency-key"] ?? ""; });
    await composer(page).fill("Уже отправлено");
    await composer(page).press("Enter");
    await expect(outgoing(page, "Уже отправлено")).toHaveCount(1);
    await expect.poll(async () => (await stored(page)).attempts).toEqual([]);
    // As if the tab had closed between the server's answer and the removal of the local record.
    await inject(page, "attempts", {
      v: 1, account: "a1", project: "p1", ticket: "t1", key, text: "Уже отправлено", file: null, state: "sending", reason: "", tries: 1, createdAt: Date.now(),
    });
    await page.reload();
    await expect(outgoing(page, "Уже отправлено")).toHaveCount(1);
    await expect(attempt(page)).toBeHidden();
    await expect.poll(async () => (await stored(page)).attempts).toEqual([]);
    expect((await stubLog(request)).filter((entry) => entry.path.endsWith("/tickets/t1/send"))).toHaveLength(1);
  });

  test("attempts of different dialogues and projects do not mix after a reload", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await page.route(SEND, (route) => route.abort("failed"), { times: 1 });
    await composer(page).fill("Только для Анны");
    await composer(page).press("Enter");
    await expect(attempt(page)).toBeVisible();
    await page.reload();
    await expect(attempt(page)).toContainText("Только для Анны");
    await dialogue(page, /Борис Петров/).click();
    await expect(attempt(page)).toBeHidden();
    await chooseProject(page, "Второй проект");
    await dialogue(page, /Григорий из второго/).click();
    await expect(attempt(page)).toBeHidden();
    await chooseProject(page, "Поддержка");
    await openAnna(page);
    await expect(attempt(page)).toContainText("Только для Анны");
  });
});

test.describe("storage and accounts", () => {
  test("without IndexedDB the console works and says that a reload would lose the work", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await page.addInitScript(() => {
      IDBFactory.prototype.open = () => { throw new DOMException("Storage is disabled.", "SecurityError"); };
    });
    await start(page, context, request);
    await openAnna(page);
    await expect(page.getByRole("alert")).toHaveText("Браузер не сохраняет черновики и отправки: они пропадут после обновления страницы, черновики — и после смены проекта.");
    await page.route(SEND, (route) => route.abort("failed"), { times: 1 });
    await composer(page).fill("Без хранилища");
    await composer(page).press("Enter");
    await expect(attempt(page)).toContainText("Эта отправка не сохранена в браузере");
    await attempt(page).getByRole("button", { name: "Повторить отправку" }).click();
    await expect(outgoing(page, "Без хранилища")).toHaveCount(1);
  });

  test("no room for a file: the text is kept, the file is named to be attached again", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await page.addInitScript(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
        // The bytes of a draft's file: the draft itself, its text, still fits.
        if ((value as { bytes?: unknown }).bytes) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        return put.call(this, value, key);
      };
    });
    await start(page, context, request);
    await openAnna(page);
    await composer(page).fill("Текст с файлом");
    await page.locator('input[type="file"]').setInputFiles({ name: "scan.png", mimeType: "image/png", buffer: PNG });
    await expect(page.getByRole("alert")).toHaveText("Вложение «scan.png» не удалось сохранить в браузере: после обновления страницы прикрепите его снова.");
    await expect.poll(async () => await draftOf(page, "t1")).toMatchObject({ text: "Текст с файлом", files: [], lostFiles: ["scan.png"] });
    await page.reload();
    await expect(composer(page)).toHaveValue("Текст с файлом");
    await expect(preview(page)).toBeHidden();
    await expect(page.getByRole("alert")).toHaveText("Вложение «scan.png» не сохранилось в браузере: прикрепите его снова.");
  });

  test("a damaged record is skipped, the console keeps working", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await inject(page, "drafts", { account: "a1", project: "p1", ticket: "t1", v: 99, text: 42 });
    await inject(page, "attempts", { account: "a1", project: "p1", ticket: "t1", v: 1, key: 7, state: "lost" });
    await page.reload();
    await expect(composer(page)).toHaveValue("");
    await expect(composer(page)).toBeEnabled();
    await expect(attempt(page)).toBeHidden();
    await expect.poll(async () => await stored(page)).toEqual({ drafts: [], attempts: [] });
  });

  test("signing out asks before removing the drafts; staying keeps them, leaving removes them", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await composer(page).fill("Не потерять");
    await expect.poll(async () => (await draftOf(page, "t1"))?.text).toBe("Не потерять");
    const menu = page.getByRole("button", { name: /^Меню аккаунта/ });
    await menu.click();
    await page.getByRole("menuitem", { name: "Выйти" }).click();
    const ask = page.getByRole("alertdialog", { name: "Выйти и удалить черновики?" });
    await expect(ask).toContainText("черновики (1)");
    await ask.getByRole("button", { name: "Остаться" }).click();
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(composer(page)).toHaveValue("Не потерять");
    await menu.click();
    await page.getByRole("menuitem", { name: "Выйти" }).click();
    await ask.getByRole("button", { name: "Выйти и удалить" }).click();
    await expect(page.locator("#login-screen")).toBeVisible();
    await expect.poll(async () => await stored(page)).toEqual({ drafts: [], attempts: [] });
    await page.locator('input[name="login"]').fill("operator");
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByRole("button", { name: "Войти" }).click();
    await openAnna(page);
    await expect(composer(page)).toHaveValue("");
  });

  test("leaving when the session has already ended still removes the work", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await composer(page).fill("Не оставлять на устройстве");
    await expect.poll(async () => (await draftOf(page, "t1"))?.text).toBe("Не оставлять на устройстве");
    // The session ended on the server: the sign-out itself answers 401.
    await page.route("**/console/logout", (route) => route.fulfill({ status: 401, json: { detail: "Войдите в панель." } }));
    await page.getByRole("button", { name: /^Меню аккаунта/ }).click();
    await page.getByRole("menuitem", { name: "Выйти" }).click();
    await page.getByRole("alertdialog", { name: "Выйти и удалить черновики?" }).getByRole("button", { name: "Выйти и удалить" }).click();
    await expect(page.locator("#login-screen")).toBeVisible();
    await expect.poll(async () => await stored(page)).toEqual({ drafts: [], attempts: [] });
    expect(await page.evaluate(() => sessionStorage.getItem("resolvate.workspace"))).toBeNull();
  });

  test("an expired session keeps the work for the same account and shows nothing to another one", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    await composer(page).fill("Работа оператора");
    await expect.poll(async () => (await draftOf(page, "t1"))?.text).toBe("Работа оператора");
    // The session ends on the server: the next request answers 401.
    await page.route("**/console/projects/p1/tickets/t2", (route) => route.fulfill({ status: 401, json: { detail: "Войдите в панель." } }), { times: 1 });
    await dialogue(page, /Борис Петров/).click();
    await expect(page.locator("#login-screen")).toBeVisible();
    await page.locator('input[name="login"]').fill("irina");
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByRole("button", { name: "Войти" }).click();
    await openAnna(page);
    await expect(composer(page)).toHaveValue("");
    expect((await stored(page)).drafts.map((item) => [item.account, item.text])).toEqual([["a1", "Работа оператора"]]);

    await page.getByRole("button", { name: /^Меню аккаунта/ }).click();
    await page.getByRole("menuitem", { name: "Выйти" }).click();
    await expect(page.locator("#login-screen")).toBeVisible();
    await page.locator('input[name="login"]').fill("operator");
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByRole("button", { name: "Войти" }).click();
    await openAnna(page);
    await expect(composer(page)).toHaveValue("Работа оператора");
  });

  test("two tabs writing the same draft: the later one says the other changed it", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await openAnna(page);
    const second = await context.newPage();
    await second.goto(CONSOLE);
    await openAnna(second);
    await composer(page).fill("Из первой вкладки");
    await expect.poll(async () => (await draftOf(page, "t1"))?.text).toBe("Из первой вкладки");
    await composer(second).fill("Из второй вкладки");
    await expect(second.getByRole("alert")).toHaveText("Черновик этого диалога меняли в другой вкладке: сохранён текст из этой вкладки.");
    await expect.poll(async () => (await draftOf(page, "t1"))?.text).toBe("Из второй вкладки");
    // The first tab still holds its own text: nothing is lost unseen.
    await expect(composer(page)).toHaveValue("Из первой вкладки");
    await second.close();
  });
});
