import type { APIRequestContext, BrowserContext, Page, Route } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, stubLog, test } from "./fixtures";

// Sending an operator's reply (stores/chat.ts): every press is an attempt with its own frozen text, file
// and idempotency key. The stub saves a message once per key and refuses the key with other content,
// as console_service.send() does. Every test also fails on a CSP violation or a console error.
const CONSOLE = "/console/";
const SEND = "**/console/projects/p1/tickets/t1/send";
const list = (page: Page) => page.getByRole("listbox", { name: "Диалоги" });
const history = (page: Page) => page.getByRole("region", { name: "Переписка" });
const composer = (page: Page) => page.getByRole("textbox", { name: "Текст ответа" });
const attempt = (page: Page) => page.getByRole("region", { name: "Отправка с неизвестным результатом" });
const retry = (page: Page) => attempt(page).getByRole("button", { name: /^(Повторить отправку|Повторяем…)$/ });
const outgoing = (page: Page, text: string) => history(page).locator("article.outgoing").filter({ hasText: text });

async function start(page: Page, context: BrowserContext, request: APIRequestContext): Promise<void> {
  await scenario(request, { me: "session" });
  await context.addCookies([SESSION_COOKIE]);
  await page.goto(CONSOLE);
  await list(page).getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(history(page).getByText("И ещё вопрос про оплату")).toBeVisible();
}

/** The keys and texts of the send requests the stub received. */
async function sent(request: APIRequestContext): Promise<number> {
  return (await stubLog(request)).filter((entry) => entry.method === "POST" && entry.path.endsWith("/tickets/t1/send")).length;
}

interface Seen { key: string; text: string }
function watchSends(page: Page): Seen[] {
  const seen: Seen[] = [];
  page.on("request", (item) => {
    if (!item.url().endsWith("/tickets/t1/send")) return;
    const body = item.postDataBuffer()?.toString("utf8") ?? "";
    seen.push({ key: item.headers()["x-idempotency-key"] ?? "", text: /name="text"\r\n\r\n([\s\S]*?)\r\n--/.exec(body)?.[1] ?? "" });
  });
  return seen;
}

/** The server saves the message, but its answer never reaches the browser. */
async function loseAnswer(route: Route): Promise<void> {
  await route.fetch();
  await route.abort("failed");
}

test.describe("sending a reply", () => {
  test("the answer is lost after the server saved the message: the history settles it, nothing is sent twice", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await page.route(SEND, loseAnswer, { times: 1 });
    await composer(page).fill("Ваш заказ отправлен.");
    await composer(page).press("Enter");
    // The live history shows the saved message with its key: the attempt was taken.
    await expect(outgoing(page, "Ваш заказ отправлен.")).toHaveCount(1);
    await expect(attempt(page)).toBeHidden();
    await expect(page.getByRole("alert")).toHaveText("Сообщение из отправки с неизвестным результатом есть в истории: сервер его принял.");
    await expect(composer(page)).toHaveValue("");
    expect(await sent(request)).toBe(1);
  });

  test("the answer is lost and the operator edits the draft: a retry sends the original under its key, once", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    const seen = watchSends(page);
    // The history waits: the attempt is settled by its retry, not by the live refresh.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/console/projects/p1/tickets/t1/sync", async (route) => {
      await held;
      await route.continue();
    });
    await page.route(SEND, loseAnswer, { times: 1 });
    await composer(page).fill("Цена — 990 ₽.");
    await composer(page).press("Enter");
    await expect(attempt(page)).toBeVisible();
    await expect(attempt(page).getByRole("alert")).toContainText("Результат отправки неизвестен.");
    await expect(attempt(page)).toContainText("Цена — 990 ₽.");
    await expect(composer(page)).toBeEnabled();

    // The draft is fixed: the attempt keeps what it sent, and the fixed text does not go under its key.
    await composer(page).fill("Цена — 1 090 ₽.");
    await composer(page).press("Enter");
    await expect(retry(page)).toBeFocused();
    await expect(page.getByRole("alert").filter({ hasText: "Сначала повторите" })).toBeVisible();
    expect(seen).toHaveLength(1);
    await retry(page).click();
    await expect(attempt(page)).toBeHidden();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[0]!.text).toBe("Цена — 990 ₽.");
    await expect(composer(page)).toHaveValue("Цена — 1 090 ₽.");
    release();
    await expect(outgoing(page, "Цена — 990 ₽.")).toHaveCount(1);
    await expect(outgoing(page, "Цена — 1 090 ₽.")).toHaveCount(0);
    expect(await sent(request)).toBe(2);
  });

  test("lost before the server: the same text again is the same attempt, with its file and key", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    const seen = watchSends(page);
    await page.route(SEND, (route) => route.abort("failed"), { times: 1 });
    await page.locator('input[type="file"]').setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: Buffer.from("89504e47", "hex") });
    await composer(page).fill("Фото заказа");
    await page.getByRole("button", { name: "Отправить" }).click();
    await expect(attempt(page)).toContainText("Нет связи с сервером.");
    await expect(attempt(page)).toContainText("photo.png");
    // Unchanged text and file: pressing "Отправить" again is the safe retry.
    await page.getByRole("button", { name: "Отправить" }).click();
    await expect(attempt(page)).toBeHidden();
    await expect(page.getByRole("group", { name: "Выбранное вложение" })).toBeHidden();
    await expect(outgoing(page, "Фото заказа")).toHaveCount(1);
    expect(seen.map((item) => item.key)).toEqual([seen[0]!.key, seen[0]!.key]);
  });

  test("an explicit refusal keeps the draft and ends the attempt; the next send is new", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    const seen = watchSends(page);
    await page.route(SEND, (route) => route.fulfill({ status: 409, json: { detail: "Клиент заблокирован." } }), { times: 1 });
    await composer(page).fill("Здравствуйте!");
    await composer(page).press("Enter");
    await expect(page.getByRole("alert")).toHaveText("Клиент заблокирован.");
    await expect(attempt(page)).toBeHidden();
    await expect(composer(page)).toHaveValue("Здравствуйте!");
    await composer(page).press("Enter");
    await expect(outgoing(page, "Здравствуйте!")).toHaveCount(1);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.key).not.toBe(seen[0]!.key);
  });

  test("a request that hangs past the deadline frees the box and stays retryable", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await page.clock.install();
    await start(page, context, request);
    const seen = watchSends(page);
    await page.route(SEND, () => undefined, { times: 1 });
    await composer(page).fill("Минутку, проверяю.");
    await composer(page).press("Enter");
    await expect(composer(page)).toBeDisabled();
    await expect(page.getByRole("button", { name: "Отправить" })).toHaveAttribute("aria-disabled", "true");
    // A second press while it runs sends nothing.
    await page.getByRole("button", { name: "Отправить" }).click({ force: true });
    await page.clock.runFor(30_000);
    await expect(attempt(page)).toContainText("Сервер не ответил за 30 с.");
    await expect(composer(page)).toBeEnabled();
    expect(seen).toHaveLength(1);
    await retry(page).click();
    await expect(attempt(page)).toBeHidden();
    await expect(outgoing(page, "Минутку, проверяю.")).toHaveCount(1);
    expect(seen.map((item) => item.key)).toEqual([seen[0]!.key, seen[0]!.key]);
  });

  test("a first request that reaches the server after its retry saves nothing twice", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await page.clock.install();
    await start(page, context, request);
    let release!: () => void;
    const late = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => { reached = resolve; });
    let first = true;
    await page.route(SEND, async (route) => {
      if (!first) return route.continue();
      first = false;
      await late;
      // The browser gave up on it long ago; the request still reaches the server now.
      await route.fetch().catch(() => undefined);
      reached();
      await route.abort().catch(() => undefined);
    });
    await composer(page).fill("Поздний запрос");
    await composer(page).press("Enter");
    await page.clock.runFor(30_000);
    await expect(attempt(page)).toContainText("Сервер не ответил за 30 с.");
    await retry(page).click();
    await expect(attempt(page)).toBeHidden();
    await expect(outgoing(page, "Поздний запрос")).toHaveCount(1);
    release();
    await arrived;
    expect(await sent(request)).toBe(2);
    await composer(page).fill("Следующий ответ");
    await composer(page).press("Enter");
    await expect(outgoing(page, "Следующий ответ")).toHaveCount(1);
    await expect(outgoing(page, "Поздний запрос")).toHaveCount(1);
  });

  test("a double click sends once", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await page.route(SEND, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.continue();
    }, { times: 1 });
    await composer(page).fill("Один раз");
    await page.getByRole("button", { name: "Отправить" }).dblclick();
    await expect(outgoing(page, "Один раз")).toHaveCount(1);
    expect(await sent(request)).toBe(1);
  });

  test("a saved message whose history fails to reload stays sent", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    // The first history request after the send fails, not a background refresh before it.
    let armed = false;
    let failed = false;
    await page.route(SEND, async (route) => {
      await route.continue();
      armed = true;
    }, { times: 1 });
    await page.route("**/console/projects/p1/tickets/t1/sync", async (route) => {
      if (!armed || failed) return route.continue();
      failed = true;
      await route.fulfill({ status: 500, json: { detail: "Ошибка сервера." } });
    });
    await composer(page).fill("Принято");
    await composer(page).press("Enter");
    await expect(page.getByRole("alert")).toHaveText("Сообщение принято сервером, но историю не удалось обновить: Ошибка сервера.");
    await expect(attempt(page)).toBeHidden();
    await expect(composer(page)).toHaveValue("");
    await expect(outgoing(page, "Принято")).toHaveCount(1);
    expect(await sent(request)).toBe(1);
  });

  test("dialogues and projects: no switch while sending; an unknown attempt waits in its dialogue", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(SEND, async (route) => {
      await held;
      await route.abort("failed");
    }, { times: 1 });
    await composer(page).fill("Для Анны");
    await composer(page).press("Enter");
    await expect(composer(page)).toBeDisabled();
    // While the request runs the dialogue and the project stay.
    await list(page).getByRole("option", { name: /Борис Петров/ }).click();
    await expect(history(page).getByText("И ещё вопрос про оплату")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Текущий проект/ })).toBeDisabled();
    release();
    await expect(attempt(page)).toBeVisible();

    await list(page).getByRole("option", { name: /Борис Петров/ }).click();
    await expect(attempt(page)).toBeHidden();
    await composer(page).fill("Для Бориса");
    await list(page).getByRole("option", { name: /Анна Смирнова/ }).click();
    await expect(attempt(page)).toContainText("Для Анны");
    await page.getByRole("button", { name: /^Текущий проект/ }).click();
    await page.getByRole("menuitemradio", { name: "Второй проект" }).click();
    await expect(attempt(page)).toBeHidden();
    await page.getByRole("button", { name: /^Текущий проект/ }).click();
    await page.getByRole("menuitemradio", { name: "Поддержка" }).click();
    await list(page).getByRole("option", { name: /Анна Смирнова/ }).click();
    await expect(attempt(page)).toContainText("Для Анны");
    await retry(page).click();
    await expect(attempt(page)).toBeHidden();
    await expect(outgoing(page, "Для Анны")).toHaveCount(1);

    // Giving up an attempt keeps the draft and sends nothing.
    await page.route(SEND, (route) => route.abort("failed"), { times: 1 });
    await composer(page).fill("Лишний ответ");
    await composer(page).press("Enter");
    await expect(attempt(page)).toBeVisible();
    await attempt(page).getByRole("button", { name: "Не повторять" }).click();
    await expect(attempt(page)).toBeHidden();
    await expect(composer(page)).toHaveValue("Лишний ответ");
    await expect(composer(page)).toBeFocused();
    await expect(outgoing(page, "Лишний ответ")).toHaveCount(0);
  });
});
