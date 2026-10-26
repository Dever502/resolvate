import type { APIRequestContext, BrowserContext, Page, Route } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, stubLog, test } from "./fixtures";

// Running a command (composer/CommandPicker.vue, lib/commandAttempt.ts): reading and low-risk commands run on Enter, a
// change with consequences asks first in a confirmation that says what changes, for whom; a finished command leaves
// the reply box and frees the next one; an outcome nobody knows keeps its key across a reload, is repeated under it
// and is given up only explicitly. Nothing of it moves the history. The server is played by routes; every test also
// fails on a CSP violation or a console error.
const COMMANDS = [
  { name: "info", description: "Информация о клиенте", arguments: "", mutation: false },
  { name: "subinfo", description: "Подписка Remnawave", arguments: "", mutation: false },
  { name: "notes", description: "Прочитать внутренние заметки", arguments: "", mutation: false },
  { name: "note", description: "Добавить внутреннюю заметку", arguments: "<текст>", mutation: true },
  { name: "stop", description: "Закрыть тикет с уведомлением", arguments: "", mutation: true },
  { name: "hidestop", description: "Закрыть тикет без уведомления", arguments: "", mutation: true },
  { name: "block", description: "Заблокировать клиента", arguments: "", mutation: true },
  { name: "unblock", description: "Разблокировать клиента", arguments: "", mutation: true },
  { name: "gift", description: "Продлить подписку", arguments: "<дни: 1–9999>", mutation: true },
  { name: "resetkey", description: "Перевыпустить ключи подписки", arguments: "", mutation: true },
  { name: "revokelink", description: "Перевыпустить ссылку подписки", arguments: "", mutation: true },
  { name: "resetdevices", description: "Сбросить устройства", arguments: "", mutation: true },
  { name: "closeall", description: "Закрыть все тикеты проекта без уведомления", arguments: "", mutation: true },
];

interface Call { ticket: string; command: string; key: string; body: unknown }
const input = (page: Page) => page.getByRole("textbox", { name: "Текст ответа" });
const popup = (page: Page) => page.locator(".command-options");
const toast = (page: Page) => page.locator(".command-toast-region");
const confirmation = (page: Page, name: string | RegExp) => page.getByRole("alertdialog", { name });

/** Signs in on Анна's dialogue; every command is answered by `answer` (default: completed) and recorded. */
async function start(page: Page, context: BrowserContext, request: APIRequestContext, answer?: (route: Route, call: Call) => Promise<void>): Promise<Call[]> {
  const calls: Call[] = [];
  await scenario(request, { me: "session" });
  await context.addCookies([SESSION_COOKIE]);
  await page.route("**/console/projects/*/commands", (route) => route.fulfill({ json: COMMANDS }));
  await page.route(/\/console\/projects\/[^/]+\/tickets\/[^/]+\/commands\/[a-z]+$/, async (route) => {
    const [, ticket, command] = new URL(route.request().url()).pathname.match(/\/tickets\/([^/]+)\/commands\/([a-z]+)$/)!;
    const call = { ticket: ticket!, command: command!, key: route.request().headers()["x-idempotency-key"]!, body: route.request().postDataJSON() };
    calls.push(call);
    if (answer) await answer(route, call);
    else await route.fulfill({ json: { status: "completed", message: command === "note" ? "Заметка добавлена." : command === "gift" ? "Подписка продлена на 30 дней." : `Выполнено: /${command}` } });
  });
  await page.goto("/console/");
  await page.getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(input(page)).toBeEditable();
  return calls;
}

async function enter(page: Page, text: string): Promise<void> {
  await input(page).fill(text);
  await input(page).press("Escape");
  await input(page).press("Enter");
}

function layout(page: Page) {
  return page.evaluate(() => {
    const view = document.querySelector<HTMLElement>(".messages")!;
    return {
      history: view.clientHeight,
      area: document.querySelector<HTMLElement>(".composer-area")!.getBoundingClientRect().height,
      composer: document.querySelector<HTMLElement>(".composer")!.getBoundingClientRect().top,
      fromEnd: Math.round(view.scrollHeight - view.scrollTop - view.clientHeight),
    };
  });
}

test("reading and low-risk commands run on Enter without a confirmation; results stay, changes say so briefly", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  const calls = await start(page, context, request);
  const before = await layout(page);
  for (const [text, expected] of [["/info", "Выполнено: /info"], ["/subinfo", "Выполнено: /subinfo"], ["/notes", "Выполнено: /notes"]] as const) {
    await enter(page, text);
    const result = popup(page).getByRole("status", { name: "Результат команды" });
    await expect(result).toHaveText(expected);
    await expect(popup(page).locator(".command-result-title")).toHaveText(`Результат ${text}`);
    await expect(popup(page).getByRole("button", { name: "Скопировать" })).toBeVisible();
    // The command left the box: Enter again runs nothing.
    await expect(input(page)).toHaveValue("");
    await input(page).press("Enter");
    expect(await layout(page)).toEqual(before);
  }
  for (const text of ["/note Звонила вчера", "/hidestop", "/unblock"]) {
    await enter(page, text);
    await expect(toast(page)).toContainText(text === "/note Звонила вчера" ? "Заметка добавлена." : `Выполнено: ${text}`);
    await expect(confirmation(page, /./)).toHaveCount(0);
    await expect(input(page)).toHaveValue("");
    expect(await layout(page)).toEqual(before);
  }
  expect(calls.map((call) => call.command)).toEqual(["info", "subinfo", "notes", "note", "hidestop", "unblock"]);
  // The notice goes by itself.
  await expect(toast(page)).toBeEmpty({ timeout: 6000 });
  expect((await stubLog(request)).filter((entry) => entry.path.endsWith("/send"))).toEqual([]);
});

test("/gift 30 asks first: cancel and Escape send nothing, the confirmation sends once, Enter after it nothing more", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  const calls = await start(page, context, request);
  const before = await layout(page);
  await enter(page, "/gift 30");
  const ask = confirmation(page, "Продлить подписку?");
  await expect(ask).toContainText("Подписка клиента «Анна Смирнова» в Remnawave будет продлена на 30 дней, клиент получит уведомление.");
  // The safe choice has the focus.
  await expect(ask.getByRole("button", { name: "Отмена" })).toBeFocused();
  expect(await layout(page)).toEqual(before);
  await ask.getByRole("button", { name: "Отмена" }).click();
  await expect(ask).toBeHidden();
  await expect(input(page)).toBeFocused();
  await input(page).press("Enter");
  await expect(ask).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(ask).toBeHidden();
  expect(calls).toEqual([]);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("resolvate.command")))).toEqual([]);

  await input(page).press("Enter");
  await ask.getByRole("button", { name: "Продлить на 30 дней" }).click();
  await expect(toast(page)).toContainText("Подписка продлена на 30 дней.");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body).toEqual({ arguments: "30" });
  await expect(input(page)).toHaveValue("");
  await expect(input(page)).toBeFocused();
  await input(page).press("Enter");
  await expect(ask).toHaveCount(0);
  expect(calls).toHaveLength(1);
  // The same again is a new, consciously confirmed operation with a new key: no «Новая команда» in between.
  await enter(page, "/gift 30");
  await confirmation(page, "Продлить подписку?").getByRole("button", { name: "Продлить на 30 дней" }).click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1]!.key).not.toBe(calls[0]!.key);
  await expect(page.getByText("Новая команда")).toHaveCount(0);
  expect(await layout(page)).toEqual(before);
});

test("the confirmations say what changes: /revokelink, /block, /stop, /resetkey, /resetdevices, /closeall with the project", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  const calls = await start(page, context, request);
  const cases: [string, string, string, string][] = [
    ["/revokelink", "Перевыпустить ссылку подписки?", "Прежняя ссылка подписки клиента «Анна Смирнова» станет недействительной", "Перевыпустить ссылку"],
    ["/block", "Заблокировать клиента?", "его новые сообщения перестанут попадать к операторам", "Заблокировать"],
    ["/stop", "Закрыть обращение с уведомлением?", "клиент получит уведомление о закрытии", "Закрыть и уведомить"],
    ["/resetkey", "Перевыпустить ключи подписки?", "прежние перестанут работать", "Перевыпустить ключи"],
    ["/resetdevices", "Сбросить устройства?", "будут удалены", "Сбросить устройства"],
  ];
  for (const [text, title, consequence, action] of cases) {
    await enter(page, text);
    const ask = confirmation(page, title);
    await expect(ask).toContainText(consequence);
    await expect(ask.getByRole("button", { name: action })).toBeVisible();
    await ask.getByRole("button", { name: "Отмена" }).click();
    await expect(ask).toBeHidden();
  }
  expect(calls).toEqual([]);

  // The bulk action names the project and takes its name typed out.
  await enter(page, "/closeall");
  const all = confirmation(page, "Закрыть все обращения проекта?");
  await expect(all).toContainText("Все открытые обращения проекта «Поддержка» будут закрыты без уведомления клиентов — не только этот диалог.");
  await all.getByRole("button", { name: "Закрыть все обращения" }).click();
  await expect(all.getByRole("alert")).toHaveText("Введите название проекта точно так, как оно написано.");
  expect(calls).toEqual([]);
  await all.getByRole("textbox", { name: "Название проекта" }).fill("Поддержка");
  await all.getByRole("button", { name: "Закрыть все обращения" }).click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]!.command).toBe("closeall");
});

test("a double confirmation sends one request, and a dialogue changed meanwhile gets nothing of it", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  let release!: () => void;
  let held = new Promise<void>((resolve) => { release = resolve; });
  const calls = await start(page, context, request, async (route, call) => {
    await held;
    await route.fulfill({ json: { status: "completed", message: call.command === "info" ? "Клиент: Анна Смирнова" : "Клиент заблокирован." } });
  });
  await enter(page, "/block");
  const ask = confirmation(page, "Заблокировать клиента?");
  const action = ask.getByRole("button", { name: "Заблокировать" });
  await action.click();
  await ask.getByRole("button", { name: "Выполняем…" }).click({ force: true });
  await page.keyboard.press("Escape");
  await expect(ask).toBeVisible();
  await expect.poll(() => calls.length).toBe(1);
  release();
  await expect(ask).toBeHidden();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.ticket).toBe("t1");

  // While a command runs, another dialogue does not open (as while a message is sent): the request and its result
  // stay Анна's.
  held = new Promise<void>((resolve) => { release = resolve; });
  await enter(page, "/info");
  await expect.poll(() => calls.length).toBe(2);
  await page.getByRole("option", { name: /Борис Петров/ }).click();
  await expect(page.locator("#customer-open")).toContainText("Анна Смирнова");
  release();
  await expect(popup(page).getByRole("status", { name: "Результат команды" })).toHaveText("Клиент: Анна Смирнова");
  expect(calls.map((call) => call.ticket)).toEqual(["t1", "t1"]);
});

test("an unknown outcome keeps its key across a reload, is repeated under it, and is given up only explicitly", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  let mode: "unknown" | "lost" | "completed" = "unknown";
  const calls = await start(page, context, request, async (route) => {
    if (mode === "lost") return route.abort("connectionreset");
    await route.fulfill({ json: mode === "unknown"
      ? { status: "unknown", message: "Команда выполняется или её результат неизвестен." }
      : { status: "completed", message: "Подписка продлена на 30 дней." } });
  });
  const before = await layout(page);
  await enter(page, "/gift 30");
  await confirmation(page, "Продлить подписку?").getByRole("button", { name: "Продлить на 30 дней" }).click();
  const unknown = popup(page).locator(".command-unknown");
  // «unknown» from the server is not a success: the text stays, the key stays.
  await expect(unknown).toContainText("Результат /gift 30 неизвестен");
  await expect(unknown).toContainText("Команда выполняется или её результат неизвестен.");
  await expect(toast(page)).toBeEmpty();
  await expect(input(page)).toHaveValue("/gift 30");
  expect(await layout(page)).toEqual(before);
  // Another change waits for it; a reading does not.
  await enter(page, "/block");
  await expect(popup(page).getByRole("alert").filter({ hasText: "результат предыдущей неизвестен" })).toBeVisible();
  await expect(confirmation(page, /./)).toHaveCount(0);
  expect(calls).toHaveLength(1);

  mode = "lost";
  await page.reload();
  await expect(popup(page).locator(".command-unknown")).toContainText("Результат /gift 30 неизвестен");
  await popup(page).getByRole("button", { name: "Повторить запрос" }).click();
  await expect(popup(page).locator(".command-unknown")).toContainText("Нет связи с сервером.");
  mode = "completed";
  await popup(page).getByRole("button", { name: "Повторить запрос" }).click();
  await expect(toast(page)).toContainText("Подписка продлена на 30 дней.");
  await expect(popup(page).locator(".command-unknown")).toHaveCount(0);
  expect(calls).toHaveLength(3);
  expect(new Set(calls.map((call) => call.key)).size).toBe(1);
  expect(calls.every((call) => JSON.stringify(call.body) === JSON.stringify({ arguments: "30" }))).toBe(true);

  // Given up: only after a warning, and the next change gets a new key.
  mode = "unknown";
  await enter(page, "/gift 30");
  await confirmation(page, "Продлить подписку?").getByRole("button", { name: "Продлить на 30 дней" }).click();
  await expect(popup(page).locator(".command-unknown")).toBeVisible();
  await popup(page).getByRole("button", { name: "Отказаться от повтора" }).click();
  const give = confirmation(page, "Отказаться от повтора?");
  await expect(give).toContainText("останется неизвестным");
  await give.getByRole("button", { name: "Не отказываться" }).click();
  await expect(popup(page).locator(".command-unknown")).toBeVisible();
  await popup(page).getByRole("button", { name: "Отказаться от повтора" }).click();
  await give.getByRole("button", { name: "Отказаться от повтора" }).click();
  await expect(popup(page).locator(".command-unknown")).toHaveCount(0);
  mode = "completed";
  await input(page).press("Enter");
  await confirmation(page, "Продлить подписку?").getByRole("button", { name: "Продлить на 30 дней" }).click();
  await expect.poll(() => calls.length).toBe(5);
  expect(calls[4]!.key).not.toBe(calls[3]!.key);
});

test("a refusal, a server error, a lost answer and the deadline are told apart", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await page.clock.install();
  let mode: "403" | "500" | "lost" | "silent" = "403";
  const calls = await start(page, context, request, async (route) => {
    if (mode === "403") return route.fulfill({ status: 403, json: { detail: "Нет права на это действие." } });
    if (mode === "500") return route.fulfill({ status: 500, json: { detail: "Ошибка сервера." } });
    if (mode === "lost") return route.abort("connectionreset");
    // Never answers: the console gives up after a minute.
  });
  await enter(page, "/note контекст");
  const refusal = popup(page).locator('[data-kind="rejected"]');
  await expect(refusal).toHaveText("Нет права на это действие.");
  await expect(popup(page).locator(".command-unknown")).toHaveCount(0);
  // A refusal reserved nothing: the next change is free.
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("resolvate.command")))).toEqual([]);

  mode = "lost";
  await enter(page, "/info");
  await expect(popup(page).locator('[data-kind="connection"]')).toContainText("Команда только читает данные: её можно повторить.");

  mode = "500";
  await enter(page, "/note контекст");
  await expect(popup(page).locator(".command-unknown")).toContainText("Ошибка сервера.");
  await popup(page).getByRole("button", { name: "Отказаться от повтора" }).click();
  await confirmation(page, "Отказаться от повтора?").getByRole("button", { name: "Отказаться от повтора" }).click();

  mode = "silent";
  await enter(page, "/note контекст");
  await expect.poll(() => calls.length).toBe(4);
  await page.clock.runFor(61_000);
  await expect(popup(page).locator(".command-unknown")).toContainText("Ответ сервера не получен за минуту.");
});

test("a definitive refusal on retry clears the unknown banner and frees the next command", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  let lost = true;
  const calls = await start(page, context, request, async (route) => {
    if (lost) return route.abort("connectionreset");
    return route.fulfill({ status: 403, json: { detail: "Нет права на это действие." } });
  });
  await enter(page, "/note контекст");
  await expect(popup(page).locator(".command-unknown")).toBeVisible();
  lost = false;
  await enter(page, "/note контекст");
  await expect(popup(page).locator('[data-kind="rejected"]')).toHaveText("Нет права на это действие.");
  await expect(popup(page).locator(".command-unknown")).toHaveCount(0);
  expect(calls[1]!.key).toBe(calls[0]!.key);
  await enter(page, "/note другой контекст");
  await expect.poll(() => calls.length).toBe(3);
  expect(calls[2]!.key).not.toBe(calls[0]!.key);
});

for (const width of [375, 320]) {
  test(`at ${width} px the confirmation and an unknown outcome fit the screen`, async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await page.setViewportSize({ width, height: 640 });
    await start(page, context, request, (route) => route.fulfill({ json: { status: "unknown", message: "Результат неизвестен." } }));
    await enter(page, "/closeall");
    const all = confirmation(page, "Закрыть все обращения проекта?");
    await expect(all).toBeVisible();
    for (const part of [all, all.getByRole("button", { name: "Отмена" }), all.getByRole("button", { name: "Закрыть все обращения" })]) {
      const box = (await part.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    await all.getByRole("button", { name: "Отмена" }).click();
    await enter(page, "/gift 30");
    await confirmation(page, "Продлить подписку?").getByRole("button", { name: "Продлить на 30 дней" }).click();
    const box = (await popup(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    await expect(popup(page).getByRole("button", { name: "Повторить запрос" })).toBeInViewport({ ratio: 1 });
  });
}

test("screenshots: a confirmation, a result and an unknown outcome, desktop and phone", async ({ page, context, request, consoleErrors, attachScreenshot, browserName }, testInfo) => {
  void consoleErrors;
  await page.emulateMedia({ reducedMotion: "reduce" });
  let unknown = false;
  await start(page, context, request, (route, call) => route.fulfill({ json: unknown
    ? { status: "unknown", message: "Команда выполняется или её результат неизвестен." }
    : { status: "completed", message: call.command === "subinfo" ? "Подписка: активна до 12.12.2026\nТариф: Команда\nУстройств: 3 из 5" : "Готово." } }));
  const shoot = async (name: string) => {
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await attachScreenshot(`${name}-${theme}`);
      if (browserName === "chromium") await page.screenshot({ path: testInfo.outputPath(`${name}-${theme}.png`) });
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  };
  for (const [device, width, height] of [["desktop", 1280, 800], ["phone", 375, 812]] as const) {
    await page.setViewportSize({ width, height });
    await enter(page, "/gift 30");
    await expect(confirmation(page, "Продлить подписку?")).toBeVisible();
    await shoot(`confirm-gift-${device}`);
    await confirmation(page, "Продлить подписку?").getByRole("button", { name: "Отмена" }).click();
    await enter(page, "/closeall");
    await expect(confirmation(page, "Закрыть все обращения проекта?")).toBeVisible();
    await shoot(`confirm-closeall-${device}`);
    await confirmation(page, "Закрыть все обращения проекта?").getByRole("button", { name: "Отмена" }).click();
    unknown = false;
    await enter(page, "/subinfo");
    await expect(popup(page).getByRole("status", { name: "Результат команды" })).toContainText("Тариф");
    await shoot(`result-subinfo-${device}`);
    await popup(page).getByRole("button", { name: "Закрыть команды" }).click();
    unknown = true;
    await enter(page, "/gift 30");
    await confirmation(page, "Продлить подписку?").getByRole("button", { name: "Продлить на 30 дней" }).click();
    await expect(popup(page).locator(".command-unknown")).toBeVisible();
    await shoot(`unknown-gift-${device}`);
    await popup(page).getByRole("button", { name: "Отказаться от повтора" }).click();
    await confirmation(page, "Отказаться от повтора?").getByRole("button", { name: "Отказаться от повтора" }).click();
    await input(page).fill("");
  }
});
