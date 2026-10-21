import type { APIRequestContext, BrowserContext, Page, Route } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, stubLog, test } from "./fixtures";

// Read state of the open dialogue (components/chat/MessageList.vue, stores/chat.ts markRead,
// components/tickets/TicketList.vue): what the operator actually sees is marked read, the unread
// badge follows the server at once, and a double-click is "to the latest message", nothing more.
// Real scroll positions in a real history region; the stub counts unread messages like the server.
const CONSOLE = "/console/";
const list = (page: Page) => page.getByRole("listbox", { name: "Диалоги" });
const history = (page: Page) => page.getByRole("region", { name: "Переписка" });
const composer = (page: Page) => page.getByRole("textbox", { name: "Текст ответа" });
const row = (page: Page, name: RegExp) => list(page).getByRole("option", { name });
const badge = (page: Page, name: RegExp) => row(page, name).locator(".count");
const ANNA = /Анна Смирнова/;
const BORIS = /Борис Петров/;

async function start(page: Page, context: BrowserContext, request: APIRequestContext): Promise<void> {
  await scenario(request, { me: "session" });
  await context.addCookies([SESSION_COOKIE]);
  await page.goto(CONSOLE);
  await expect(row(page, ANNA)).toBeVisible();
}

/**
 * Lets the live refresh run its course (the one the event stream's "ready" or a change asked for;
 * the next poll is 30 s away): it reloads the open dialogue too, which must not count as an opening.
 */
async function quiet(page: Page): Promise<void> {
  await page.waitForTimeout(1600);
}

/** The stub's log since `since`: requests of one kind. */
async function requests(request: APIRequestContext, since: number, pattern: RegExp): Promise<string[]> {
  return (await stubLog(request)).filter((entry) => entry.at >= since && pattern.test(`${entry.method} ${entry.path}`))
    .map((entry) => entry.path);
}
const reads = (request: APIRequestContext, since: number, ticket = "t\\d+") =>
  requests(request, since, new RegExp(`^POST /console/projects/p1/tickets/${ticket}/read/`));
const opens = (request: APIRequestContext, since: number, ticket: string) =>
  requests(request, since, new RegExp(`^(GET /console/projects/p1/tickets/${ticket}|POST /console/projects/p1/tickets/${ticket}/sync)$`));

/** Scroll position of the history: its distance from the end, and whether the last message is in view. */
function view(page: Page): Promise<{ fromEnd: number; lastInView: boolean; top: number }> {
  return history(page).evaluate((element) => {
    const last = element.querySelectorAll("article");
    const box = element.getBoundingClientRect();
    const message = last[last.length - 1]?.getBoundingClientRect();
    return {
      fromEnd: Math.round(element.scrollHeight - element.scrollTop - element.clientHeight),
      lastInView: Boolean(message && message.top < box.bottom && message.bottom > box.top),
      top: Math.round(element.scrollTop),
    };
  });
}

async function scrollHistory(page: Page, top: number): Promise<void> {
  await history(page).evaluate((element, value) => { element.scrollTop = value; }, top);
}

/** A customer writes into a dialogue; the live refresh brings it in. */
async function incoming(request: APIRequestContext, ticket: string, text: string): Promise<void> {
  await request.post("/__stub/incoming", { data: { ticket, text } });
}

/** Holds a route until released; the released request goes on to the stub (or fails, if the page dropped it). */
function gate(): { hold: (route: Route) => Promise<void>; release: () => void } {
  let release!: () => void;
  const open = new Promise<void>((resolve) => { release = resolve; });
  return { release, hold: async (route) => { await open; await route.continue().catch(() => undefined); } };
}

test.describe("opening", () => {
  test("a click on an unread dialogue shows its latest message, marks it read once and clears the badge at once", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await expect(badge(page, ANNA)).toHaveText(/2$/);
    await quiet(page);
    const since = Date.now();
    await row(page, ANNA).click();
    await expect(history(page).getByText("И ещё вопрос про оплату")).toBeVisible();
    expect((await view(page)).lastInView).toBe(true);
    // Well before the next poll (30 s with an event stream): the list follows the confirmed receipt.
    await expect(badge(page, ANNA)).toBeHidden({ timeout: 3000 });
    expect(await reads(request, since)).toHaveLength(1);
    expect(await opens(request, since, "t1")).toHaveLength(2);
  });

  test("selecting the open dialogue again keeps its place and loads nothing", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await row(page, ANNA).click();
    await expect(badge(page, ANNA)).toBeHidden();
    await scrollHistory(page, 600);
    await quiet(page);
    const since = Date.now();
    await row(page, ANNA).click();
    await page.waitForTimeout(400);
    expect((await view(page)).top).toBe(600);
    expect(await opens(request, since, "t1")).toEqual([]);
    expect(await reads(request, since)).toEqual([]);
  });

  test("a dialogue opened again after another one sends no receipt for what was already confirmed", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    const since = Date.now();
    await row(page, ANNA).click();
    await expect(badge(page, ANNA)).toBeHidden();
    await row(page, BORIS).click();
    await expect(badge(page, BORIS)).toBeHidden();
    await row(page, ANNA).click();
    await expect(history(page).getByText("И ещё вопрос про оплату")).toBeVisible();
    await expect.poll(async () => (await view(page)).lastInView).toBe(true);
    await page.waitForTimeout(400);
    expect(await reads(request, since, "t1")).toHaveLength(1);
  });
});

test.describe("double-click", () => {
  test("on an unread dialogue: opened once, at its latest message, read, no text selected", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await quiet(page);
    const since = Date.now();
    await row(page, ANNA).dblclick();
    await expect(history(page).getByText("И ещё вопрос про оплату")).toBeVisible();
    await expect(badge(page, ANNA)).toBeHidden({ timeout: 3000 });
    expect((await view(page)).lastInView).toBe(true);
    expect(await opens(request, since, "t1")).toHaveLength(2);
    expect(await reads(request, since)).toHaveLength(1);
    expect(await page.evaluate(() => getSelection()?.toString() ?? "")).toBe("");
  });

  test("on the open dialogue read further up: to the latest message, without reloading it or touching the draft", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await row(page, ANNA).click();
    await expect(badge(page, ANNA)).toBeHidden();
    await scrollHistory(page, 600);
    await composer(page).fill("Черновик остаётся");
    await incoming(request, "t1", "Пока оператор читал выше");
    await expect(history(page).getByText("Пока оператор читал выше")).toBeAttached();
    // Reading older messages: the new one is not followed and not read.
    await expect(badge(page, ANNA)).toHaveText(/1$/);
    expect((await view(page)).top).toBe(600);
    await page.waitForTimeout(1600); // The live refresh that brought the message is over.
    const since = Date.now();
    await row(page, ANNA).dblclick();
    await expect.poll(async () => (await view(page)).lastInView).toBe(true);
    await expect(badge(page, ANNA)).toBeHidden({ timeout: 3000 });
    expect(await opens(request, since, "t1")).toEqual([]);
    expect(await reads(request, since)).toHaveLength(1);
    await expect(composer(page)).toHaveValue("Черновик остаётся");
  });

  test("while the history loads: opened once, and the view ends at the latest message once it is there", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await quiet(page);
    const history1 = gate();
    await page.route("**/console/projects/p1/tickets/t1/sync", history1.hold, { times: 1 });
    const since = Date.now();
    await row(page, ANNA).dblclick();
    await page.waitForTimeout(300);
    expect(await reads(request, since)).toEqual([]);
    history1.release();
    await expect(history(page).getByText("И ещё вопрос про оплату")).toBeVisible();
    await expect.poll(async () => (await view(page)).lastInView).toBe(true);
    await expect(badge(page, ANNA)).toBeHidden({ timeout: 3000 });
    expect(await opens(request, since, "t1")).toHaveLength(2);
    expect(await reads(request, since)).toHaveLength(1);
  });

  test("then another dialogue at once: the first one is neither read nor scrolled for", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    const history1 = gate();
    await page.route("**/console/projects/p1/tickets/t1/sync", history1.hold, { times: 1 });
    const since = Date.now();
    await row(page, ANNA).dblclick();
    await row(page, BORIS).click();
    await expect(history(page).getByText("Здравствуйте, нужна помощь")).toBeVisible();
    await expect(badge(page, BORIS)).toBeHidden({ timeout: 3000 });
    history1.release();
    await page.waitForTimeout(600);
    expect(await reads(request, since, "t1")).toEqual([]);
    expect(await reads(request, since, "t2")).toHaveLength(1);
    await expect(badge(page, ANNA)).toHaveText(/2$/);
    await expect(row(page, BORIS)).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("scrolling", () => {
  test("down by hand to a message that came while reading older ones: read once it is in view", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await row(page, ANNA).click();
    await expect(badge(page, ANNA)).toBeHidden();
    await scrollHistory(page, 600);
    await incoming(request, "t1", "Новое внизу");
    await expect(history(page).getByText("Новое внизу")).toBeAttached();
    await expect(badge(page, ANNA)).toHaveText(/1$/);
    const since = Date.now();
    await history(page).hover();
    // Wheel scrolling, as the operator would: many scroll events on the way, one receipt at the end. Firefox
    // scrolls about 335 px a notch whatever the delta, so there are notches enough for the whole history.
    for (let step = 0; step < 20; step++) await page.mouse.wheel(0, 800);
    await expect.poll(async () => (await view(page)).lastInView).toBe(true);
    await expect(badge(page, ANNA)).toBeHidden({ timeout: 3000 });
    for (let step = 0; step < 4; step++) await page.mouse.wheel(0, 200);
    await page.waitForTimeout(300);
    expect(await reads(request, since)).toHaveLength(1);
  });

  test("at the end, a new message is followed and read", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await row(page, ANNA).click();
    await expect(badge(page, ANNA)).toBeHidden();
    const since = Date.now();
    await incoming(request, "t1", "Пришло, пока оператор внизу");
    await expect(history(page).getByText("Пришло, пока оператор внизу")).toBeVisible();
    await expect.poll(async () => (await view(page)).lastInView).toBe(true);
    await expect.poll(async () => (await reads(request, since)).length).toBe(1);
    await expect(badge(page, ANNA)).toBeHidden({ timeout: 3000 });
  });

  test("older messages loaded at the top mark nothing newer read", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await row(page, ANNA).click();
    await expect(badge(page, ANNA)).toBeHidden();
    await scrollHistory(page, 600);
    await incoming(request, "t1", "Новое, пока читают старое");
    await expect(badge(page, ANNA)).toHaveText(/1$/);
    const since = Date.now();
    await scrollHistory(page, 0);
    await expect(history(page).getByText("Сообщение 1", { exact: true })).toBeAttached();
    await page.waitForTimeout(400);
    expect((await view(page)).lastInView).toBe(false);
    expect(await reads(request, since)).toEqual([]);
    await expect(badge(page, ANNA)).toHaveText(/1$/);
  });
});

test.describe("visibility", () => {
  async function setHidden(page: Page, hidden: boolean): Promise<void> {
    await page.evaluate((value) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (value ? "hidden" : "visible") });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
  }

  test("a hidden tab marks nothing; shown again with the latest message in view, it is read", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await setHidden(page, true);
    const since = Date.now();
    await row(page, BORIS).click();
    await expect(history(page).getByText("Здравствуйте, нужна помощь")).toBeVisible();
    await page.waitForTimeout(600);
    expect(await reads(request, since)).toEqual([]);
    await expect(badge(page, BORIS)).toHaveText(/1$/);
    await setHidden(page, false);
    await expect(badge(page, BORIS)).toBeHidden({ timeout: 3000 });
    expect(await reads(request, since)).toHaveLength(1);
  });

  test("on a phone: read while the dialogue is shown, not behind the list; its row shows it again at the latest, without reloading", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await page.setViewportSize({ width: 375, height: 812 });
    await start(page, context, request);
    await row(page, ANNA).click();
    await expect(history(page).getByText("И ещё вопрос про оплату")).toBeVisible();
    await page.getByRole("button", { name: "К списку диалогов" }).click();
    await expect(list(page)).toBeVisible();
    await expect(badge(page, ANNA)).toBeHidden();
    const behindList = Date.now();
    await incoming(request, "t1", "Пока виден список");
    await expect(badge(page, ANNA)).toHaveText(/1$/);
    // Behind the list the history region is hidden (no role to find), the message is in it all the same.
    await expect(page.locator(".messages article", { hasText: "Пока виден список" })).toBeAttached();
    await quiet(page);
    expect(await reads(request, behindList)).toEqual([]);
    const since = Date.now();
    await row(page, ANNA).click();
    await expect(history(page).getByText("Пока виден список")).toBeVisible();
    await expect.poll(async () => (await view(page)).lastInView).toBe(true);
    await expect.poll(async () => (await reads(request, since)).length).toBe(1);
    expect(await opens(request, since, "t1")).toEqual([]);
    await page.getByRole("button", { name: "К списку диалогов" }).click();
    await expect(badge(page, ANNA)).toBeHidden();
  });
});

test.describe("network", () => {
  test("a failed receipt leaves the badge; it is sent again on a later look and then clears it", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await page.clock.install();
    await start(page, context, request);
    await page.route("**/console/projects/p1/tickets/t2/read/*", (route) => route.fulfill({ status: 503, json: { detail: "Сервис временно недоступен." } }), { times: 1 });
    const since = Date.now();
    await row(page, BORIS).click();
    await expect(page.getByRole("alert")).toHaveText("Сервис временно недоступен.");
    await expect(badge(page, BORIS)).toHaveText(/1$/);
    // Scroll events right after the failure send nothing more.
    await history(page).dispatchEvent("scroll");
    await page.waitForTimeout(200);
    expect(await reads(request, since)).toHaveLength(0);
    await page.clock.fastForward(5_000);
    await history(page).dispatchEvent("scroll");
    await expect(badge(page, BORIS)).toBeHidden({ timeout: 3000 });
    expect(await reads(request, since)).toHaveLength(1);
  });

  test("a slow receipt: the badge clears once it is confirmed, and a message that came meanwhile stays unread", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    const receipt = gate();
    await page.route("**/console/projects/p1/tickets/t1/read/*", receipt.hold, { times: 1 });
    await row(page, ANNA).click();
    await expect(history(page).getByText("И ещё вопрос про оплату")).toBeVisible();
    await scrollHistory(page, 600);
    await incoming(request, "t1", "Пришло во время отметки");
    await expect(history(page).getByText("Пришло во время отметки")).toBeAttached();
    // Not confirmed yet: the server still counts both earlier messages and the new one.
    await expect(badge(page, ANNA)).toHaveText(/3$/);
    receipt.release();
    await expect(badge(page, ANNA)).toHaveText(/1$/, { timeout: 3000 });
  });

  test("a history answer that comes after another dialogue opened marks nothing read", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    const history1 = gate();
    await page.route("**/console/projects/p1/tickets/t1/sync", history1.hold, { times: 1 });
    const since = Date.now();
    await row(page, ANNA).click();
    await row(page, BORIS).click();
    await expect(history(page).getByText("Здравствуйте, нужна помощь")).toBeVisible();
    history1.release();
    await page.waitForTimeout(600);
    expect(await reads(request, since, "t1")).toEqual([]);
    await expect(badge(page, ANNA)).toHaveText(/2$/);
  });
});

test.describe("keyboard", () => {
  test("Enter opens a dialogue, which is read; Enter on the open one keeps its place; arrows and Home/End still move", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    // The list is one Tab stop after the folder button, at its selected (or first) dialogue.
    const folders = page.getByRole("button", { name: "Управление общими папками" });
    await folders.focus();
    await page.keyboard.press("Tab");
    await expect(row(page, ANNA)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(history(page).getByText("И ещё вопрос про оплату")).toBeVisible();
    await expect(badge(page, ANNA)).toBeHidden({ timeout: 3000 });
    await scrollHistory(page, 600);
    await quiet(page);
    await folders.focus();
    await page.keyboard.press("Tab");
    await expect(row(page, ANNA)).toBeFocused();
    const since = Date.now();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowDown");
    await expect(row(page, BORIS)).toBeFocused();
    await page.keyboard.press("Home");
    await expect(row(page, ANNA)).toBeFocused();
    await page.keyboard.press("End");
    await expect(row(page, ANNA)).not.toBeFocused();
    await page.waitForTimeout(300);
    expect((await view(page)).top).toBe(600);
    expect(await opens(request, since, "t1")).toEqual([]);
    await expect(row(page, ANNA)).toHaveAttribute("aria-selected", "true");
  });
});
