import type { APIRequestContext, BrowserContext, Locator, Page } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, stubLog, test } from "./fixtures";

// The quick replies catalog (components/composer/ReplyCatalog.vue) on the production build, against
// the stub of the catalog API (e2e/stub/api.mjs keeps the rules of src/resolvate/quick_reply_catalog.py).
// Every test also fails on a CSP violation or a console error (fixtures.ts).
const CONSOLE = "/console/";
const API = "/console/projects/p1";

async function start(page: Page, context: BrowserContext, request: APIRequestContext, data: object = {}): Promise<void> {
  await scenario(request, { me: "session", data });
  await context.addCookies([SESSION_COOKIE]);
  await page.goto(CONSOLE);
  await expect(page.locator("#workspace")).toBeVisible();
}

const opener = (page: Page) => page.getByRole("button", { name: "Управление готовыми ответами", exact: true });

/** The catalog opens from the app bar, or on a narrow screen from the app bar's drawer. */
async function openCatalog(page: Page): Promise<Locator> {
  if (page.viewportSize()!.width <= 700) {
    await page.getByRole("button", { name: /^Меню\. Проект:/ }).click();
    await page.getByRole("dialog", { name: "Resolvate" }).getByRole("button", { name: "Каталог готовых ответов" }).click();
  } else {
    await opener(page).click();
  }
  const catalog = page.getByRole("dialog", { name: "Готовые ответы" });
  await expect(catalog).toBeVisible();
  return catalog;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const groupList = (catalog: Locator) => catalog.getByRole("listbox", { name: "Группы" });
const groupNav = (catalog: Locator) => catalog.getByRole("navigation", { name: "Группы ответов" });
const group = (catalog: Locator, name: string) => groupList(catalog).getByRole("option", { name: `#${name}`, exact: true });
const detail = (catalog: Locator, name: string) => catalog.getByRole("region", { name: `Группа #${name}`, exact: true });
const results = (catalog: Locator) => catalog.getByRole("region", { name: "Результаты поиска" });
/** A reply card by the beginning of its text (its accessible name is "Ответ: " and the text on one line). */
const card = (scope: Locator, text: string) => scope.getByRole("article", { name: new RegExp(`^Ответ: ${escape(text)}`) });
const cardMenu = (scope: Locator, text: string) => card(scope, text).getByRole("button", { name: /^Действия с ответом/ });
const editor = (catalog: Locator) => catalog.getByRole("textbox", { name: "Текст готового ответа" });
const search = (catalog: Locator) => catalog.getByRole("searchbox", { name: "Поиск в каталоге" });
/** The toast of a finished change; it disappears by itself. */
const status = (catalog: Locator) => catalog.locator(".catalog-toast");
const warningNotice = (catalog: Locator) => catalog.locator(".catalog-warning");
const showWhole = (scope: Locator, text: string) => card(scope, text).getByRole("button", { name: "Показать ответ полностью" });
const collapse = (scope: Locator, text: string) => card(scope, text).getByRole("button", { name: "Свернуть ответ" });
const lines = (prefix: string, count: number) => Array.from({ length: count }, (_, line) => `${prefix} ${line + 1}`).join("\n");
/** The reply's text box: what the toggle's aria-controls points at. */
async function replyText(scope: Locator, text: string): Promise<Locator> {
  const toggle = card(scope, text).getByRole("button", { name: /^(Показать ответ полностью|Свернуть ответ)$/ });
  return scope.page().locator(`[id="${await toggle.getAttribute("aria-controls")}"]`);
}

async function replyAction(page: Page, scope: Locator, text: string, action: "Изменить" | "Перенести" | "Удалить"): Promise<void> {
  await cardMenu(scope, text).click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}

async function groupAction(page: Page, catalog: Locator, name: string, action: "Переименовать" | "Удалить группу"): Promise<void> {
  await catalog.getByRole("button", { name: `Действия с группой #${name}` }).click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}

// Another operator's change, straight through the catalog API.
async function other(page: Page, path: string, data: object): Promise<void> {
  const answer = await page.request.post(`${API}/${path}`, { data });
  expect(answer.ok(), await answer.text()).toBe(true);
}

async function serverReply(page: Page, groupId: string, id: string): Promise<{ text: string; revision: number } | undefined> {
  const rows = await (await page.request.get(`${API}/replies?group_id=${groupId}`)).json();
  return rows.find((row: { id: string }) => row.id === id);
}

async function serverGroup(page: Page, name: string): Promise<{ id: string; revision: number }> {
  const rows = await (await page.request.get(`${API}/reply-groups?q=${encodeURIComponent(name)}`)).json();
  return rows.find((row: { name: string }) => row.name === name);
}

const failWith = (status: number, detail: string) => ({ status, contentType: "application/json", body: JSON.stringify({ detail }) });

type Box = { x: number; y: number; width: number; height: number };
async function box(locator: Locator): Promise<Box> {
  const found = await locator.boundingBox();
  expect(found, "the element is rendered").not.toBeNull();
  return found!;
}

/** No two of the elements overlap on the screen. */
async function expectApart(...locators: Locator[]): Promise<void> {
  const list = await Promise.all(locators.map(box));
  for (let a = 0; a < list.length; a++) {
    for (let b = a + 1; b < list.length; b++) {
      const [one, two] = [list[a]!, list[b]!];
      const apart = one.x + one.width <= two.x + 1 || two.x + two.width <= one.x + 1
        || one.y + one.height <= two.y + 1 || two.y + two.height <= one.y + 1;
      expect(apart, `${await locators[a]!.evaluate((node) => node.outerHTML.slice(0, 80))} overlaps ${await locators[b]!.evaluate((node) => node.outerHTML.slice(0, 80))}`).toBe(true);
    }
  }
}

async function expectInside(inner: Locator, outer: Locator): Promise<void> {
  const [a, b] = [await box(inner), await box(outer)];
  expect(a.x).toBeGreaterThanOrEqual(b.x - 1);
  expect(a.y).toBeGreaterThanOrEqual(b.y - 1);
  expect(a.x + a.width).toBeLessThanOrEqual(b.x + b.width + 1);
  expect(a.y + a.height).toBeLessThanOrEqual(b.y + b.height + 1);
}

/** Neither the page nor the window nor its scrolling columns scroll sideways. */
async function expectNoSidewaysScroll(page: Page, catalog: Locator, width: number): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  expect(await catalog.evaluate((element) => [element, ...element.querySelectorAll(".catalog-scroll")]
    .every((node) => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
}

test.describe("quick replies catalog", () => {
  test("desktop: groups on the left, the open group on the right, pages of 50, scrolling inside the columns", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await page.setViewportSize({ width: 1280, height: 800 });
    await start(page, context, request, { catalog: "large" });
    const catalog = await openCatalog(page);
    // The first group by name opens by itself.
    await expect(groupList(catalog).getByRole("option")).toHaveCount(50);
    await expect(group(catalog, "группа_01")).toHaveAttribute("aria-selected", "true");
    await expect(detail(catalog, "группа_01").getByText("В группе пока нет ответов.")).toBeVisible();
    await catalog.getByRole("button", { name: "Ещё группы" }).click();
    await expect(groupList(catalog).getByRole("option")).toHaveCount(57);
    await expect(catalog.getByRole("button", { name: "Ещё группы" })).toHaveCount(0);
    await group(catalog, "общее").click();
    const general = detail(catalog, "общее");
    await expect(general.getByRole("article")).toHaveCount(50);
    await general.getByRole("button", { name: "Ещё ответы" }).click();
    await expect(general.getByRole("article")).toHaveCount(57);
    await expect(general.getByRole("button", { name: "Ещё ответы" })).toHaveCount(0);
    // Loading more keeps the open group selected.
    await expect(group(catalog, "общее")).toHaveAttribute("aria-selected", "true");

    // About 960px wide, never taller than the screen; the columns stand side by side and scroll.
    const window = await box(catalog);
    expect(window.width).toBeGreaterThanOrEqual(840);
    expect(window.width).toBeLessThanOrEqual(960);
    expect(window.y).toBeGreaterThanOrEqual(0);
    expect(window.y + window.height).toBeLessThanOrEqual(800);
    const [nav, right] = [await box(groupNav(catalog)), await box(general)];
    expect(nav.x + nav.width).toBeLessThanOrEqual(right.x + 1);
    expect(Math.abs(nav.y - right.y)).toBeLessThanOrEqual(1);
    await expectApart(search(catalog), catalog.locator(".catalog-body"));
    await expectApart(catalog.getByRole("heading", { name: "#общее" }), catalog.getByRole("button", { name: "Действия с группой #общее" }),
      general.getByRole("button", { name: "Добавить ответ" }));
    await expectApart(...(await general.getByRole("article").all()).slice(0, 4));
    expect(await catalog.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    for (const column of [groupNav(catalog), general]) {
      const scroll = column.locator(".catalog-scroll");
      expect(await scroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      expect(await scroll.evaluate((element) => getComputedStyle(element).overscrollBehaviorY)).toBe("contain");
      await expectInside(scroll, catalog);
    }
    await expectNoSidewaysScroll(page, catalog, 1280);

    // A narrower desktop keeps both columns inside the screen.
    await page.setViewportSize({ width: 900, height: 640 });
    const narrower = await box(catalog);
    expect(narrower.x).toBeGreaterThanOrEqual(0);
    expect(narrower.x + narrower.width).toBeLessThanOrEqual(900);
    expect(narrower.y + narrower.height).toBeLessThanOrEqual(640);
    await expect(groupNav(catalog)).toBeVisible();
    await expect(general).toBeVisible();
    await expectNoSidewaysScroll(page, catalog, 900);
  });

  test("app bar opener: one normal space between the two words of its label; a phone names the catalog in full, in the drawer", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    // Widths of the button and of its copy holding `text` as one plain text run: they differ when the
    // label spaces its words wider than the font does (the flex gap of .quiet between two flex items).
    const widths = (text: string) => opener(page).evaluate((button, label) => {
      const copy = button.cloneNode(false) as HTMLElement;
      copy.textContent = label;
      button.after(copy);
      const result: [number, number] = [button.getBoundingClientRect().width, copy.getBoundingClientRect().width];
      copy.remove();
      return result;
    }, text);
    await page.setViewportSize({ width: 1280, height: 800 });
    await start(page, context, request);
    // innerText follows the layout: a word in a flex item of its own comes out on a line of its own.
    expect(await opener(page).innerText()).toBe("Готовые ответы");
    const [desktop, desktopText] = await widths("Готовые ответы");
    expect(desktop).toBeCloseTo(desktopText, 0);
    await page.setViewportSize({ width: 375, height: 812 });
    // No half label in the phone's bar: the drawer says what the action does.
    await expect(opener(page)).toHaveCount(0);
    await page.getByRole("button", { name: /^Меню\. Проект:/ }).click();
    await expect(page.getByRole("dialog", { name: "Resolvate" }).getByRole("button", { name: "Каталог готовых ответов" })).toBeVisible();
  });

  test("groups: a new group opens by itself; the server's refusals stay with the typed name; rename and delete use the group menu", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    const catalog = await openCatalog(page);
    await expect(group(catalog, "общее")).toHaveAttribute("aria-selected", "true");
    const newGroup = catalog.getByRole("button", { name: "Новая группа" });
    await newGroup.click();
    const name = catalog.getByRole("textbox", { name: "Новая группа" });
    await expect(name).toBeFocused();
    // Esc closes the field only; focus returns to its button.
    await page.keyboard.press("Escape");
    await expect(name).toBeHidden();
    await expect(catalog).toBeVisible();
    await expect(newGroup).toBeFocused();

    await newGroup.click();
    await catalog.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(catalog.getByText("Введите название группы.")).toBeVisible();
    await name.fill("две группы");
    await name.press("Enter");
    await expect(catalog.getByText("Группа: 1–48 букв, цифр или знаков подчёркивания, без пробелов.")).toBeVisible();
    await expect(name).toHaveValue("две группы");
    await name.fill("#Общее");
    await name.press("Enter");
    await expect(catalog.getByText("Такая группа уже существует.")).toBeVisible();
    await name.fill("#VPN");
    await name.press("Enter");
    await expect(status(catalog)).toHaveText("Группа #vpn создана.");
    await expect(group(catalog, "vpn")).toHaveAttribute("aria-selected", "true");
    const vpn = detail(catalog, "vpn");
    await expect(vpn.getByRole("heading", { name: "#vpn" })).toBeVisible();
    await expect(vpn.getByText("В группе пока нет ответов.")).toBeVisible();
    await expect(vpn.getByRole("button", { name: "Добавить ответ" })).toBeFocused();

    await groupAction(page, catalog, "vpn", "Переименовать");
    const rename = catalog.getByRole("textbox", { name: "Новое название группы" });
    await expect(rename).toBeFocused();
    await expect(rename).toHaveValue("#vpn");
    await page.keyboard.press("Escape");
    await expect(rename).toBeHidden();
    await expect(catalog.getByRole("button", { name: "Действия с группой #vpn" })).toBeFocused();
    await groupAction(page, catalog, "vpn", "Переименовать");
    await rename.fill("#vpn_доступ");
    await rename.press("Enter");
    await expect(status(catalog)).toHaveText("Группа переименована: #vpn_доступ.");
    await expect(group(catalog, "vpn_доступ")).toHaveAttribute("aria-selected", "true");
    await expect(group(catalog, "vpn")).toHaveCount(0);
    await expect(catalog.getByRole("button", { name: "Действия с группой #vpn_доступ" })).toBeFocused();

    // A group with replies is not deleted: the server's reason is shown, nothing is judged by the page.
    await group(catalog, "общее").click();
    await groupAction(page, catalog, "общее", "Удалить группу");
    const refuse = page.getByRole("alertdialog", { name: "Удалить группу #общее?" });
    await expect(refuse.getByRole("button", { name: "Отмена" })).toBeFocused();
    await refuse.getByRole("button", { name: "Удалить группу" }).click();
    await expect(refuse.getByText("Сначала перенесите или удалите ответы из группы.")).toBeVisible();
    await refuse.getByRole("button", { name: "Отмена" }).click();
    await expect(refuse).toBeHidden();
    await expect(catalog.getByRole("button", { name: "Действия с группой #общее" })).toBeFocused();
    await expect(group(catalog, "общее")).toBeVisible();

    await group(catalog, "vpn_доступ").click();
    await groupAction(page, catalog, "vpn_доступ", "Удалить группу");
    await page.getByRole("alertdialog", { name: "Удалить группу #vpn_доступ?" }).getByRole("button", { name: "Удалить группу" }).click();
    await expect(status(catalog)).toHaveText("Группа #vpn_доступ удалена.");
    await expect(group(catalog, "vpn_доступ")).toHaveCount(0);
    await expect(groupList(catalog).getByRole("option", { selected: true })).toBeFocused();
  });

  test("replies: the editor opens on request, Enter starts a line, empty text is refused, multi-line text is saved and edited", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    const catalog = await openCatalog(page);
    const general = detail(catalog, "общее");
    await expect(general.getByRole("article")).toHaveCount(2);
    await expect(editor(catalog)).toHaveCount(0);

    await general.getByRole("button", { name: "Добавить ответ" }).click();
    await expect(catalog.getByRole("heading", { name: "Новый ответ в #общее" })).toBeVisible();
    await expect(editor(catalog)).toBeFocused();
    const save = catalog.getByRole("button", { name: "Добавить ответ" });
    await save.click();
    await expect(catalog.getByText("Введите текст ответа.")).toBeVisible();
    await editor(catalog).fill("  \n  ");
    await save.click();
    await expect(catalog.getByText("Введите текст ответа.")).toBeVisible();
    await editor(catalog).fill("а".repeat(3901));
    await expect(catalog.getByText("3901 / 3900 символов; эмодзи может занимать два")).toBeVisible();
    await save.click();
    await expect(catalog.getByText("Не больше 3900 символов.")).toBeVisible();
    await editor(catalog).fill("");
    await editor(catalog).pressSequentially("Здравствуйте!");
    await editor(catalog).press("Enter");
    await editor(catalog).pressSequentially("Проверьте настройки.");
    await expect(editor(catalog)).toHaveValue("Здравствуйте!\nПроверьте настройки.");
    // Enter only started a line: nothing was sent.
    await expect(catalog.getByRole("heading", { name: "Новый ответ в #общее" })).toBeVisible();
    expect((await stubLog(request)).filter((entry) => entry.method === "POST" && entry.path === `${API}/replies`)).toHaveLength(0);
    await save.click();
    await expect(status(catalog)).toHaveText("Ответ добавлен в #общее.");
    const created = card(general, "Здравствуйте! Проверьте настройки.");
    await expect(created.locator(".catalog-reply-text")).toHaveJSProperty("innerText", "Здравствуйте!\nПроверьте настройки.");
    await expect(cardMenu(general, "Здравствуйте! Проверьте настройки.")).toBeFocused();
    await expect(general.getByRole("article")).toHaveCount(3);

    await replyAction(page, general, "Здравствуйте! Проверьте", "Изменить");
    await expect(catalog.getByRole("heading", { name: "Изменение ответа в #общее" })).toBeVisible();
    await expect(editor(catalog)).toBeFocused();
    await expect(editor(catalog)).toHaveValue("Здравствуйте!\nПроверьте настройки.");
    // The caret waits at the end of the text.
    await page.keyboard.press("Enter");
    await page.keyboard.type("Хорошего дня.");
    await catalog.getByRole("button", { name: "Сохранить ответ" }).click();
    await expect(status(catalog)).toHaveText("Ответ сохранён.");
    await expect(card(general, "Здравствуйте! Проверьте настройки. Хорошего дня.").locator(".catalog-reply-text"))
      .toHaveJSProperty("innerText", "Здравствуйте!\nПроверьте настройки.\nХорошего дня.");
    await expect(cardMenu(general, "Здравствуйте! Проверьте настройки. Хорошего дня.")).toBeFocused();
    // A long reply is cut in its card and shown whole in the editor.
    const long = Array.from({ length: 12 }, (_, line) => `Строка ${line + 1} длинного ответа.`).join("\n");
    await other(page, "replies", { group_id: "g1", text: long });
    await catalog.getByRole("button", { name: "Действия с группой #общее" }).focus();
    await group(catalog, "оплата").click();
    await group(catalog, "общее").click();
    const text = card(general, "Строка 1 длинного").locator(".catalog-reply-text");
    expect(await text.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await replyAction(page, general, "Строка 1 длинного", "Изменить");
    await expect(editor(catalog)).toHaveValue(long);
  });

  test("unsaved drafts: cancel, Esc, another group and closing the window ask first", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    const catalog = await openCatalog(page);
    const general = detail(catalog, "общее");
    const add = general.getByRole("button", { name: "Добавить ответ" });
    // An untouched editor closes at once.
    await add.click();
    await catalog.getByRole("button", { name: "Отмена" }).click();
    await expect(editor(catalog)).toHaveCount(0);
    await expect(add).toBeFocused();

    await add.click();
    await editor(catalog).fill("Черновик");
    const discard = page.getByRole("alertdialog", { name: "Не сохранять изменения?" });
    await catalog.getByRole("button", { name: "Отмена" }).click();
    await expect(discard.getByRole("button", { name: "Вернуться к ответу" })).toBeFocused();
    await discard.getByRole("button", { name: "Вернуться к ответу" }).click();
    await expect(discard).toBeHidden();
    await expect(editor(catalog)).toHaveValue("Черновик");

    await group(catalog, "оплата").click();
    await expect(discard).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(discard).toBeHidden();
    await expect(group(catalog, "общее")).toHaveAttribute("aria-selected", "true");
    await expect(editor(catalog)).toHaveValue("Черновик");

    await catalog.getByRole("button", { name: "Закрыть" }).click();
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "Вернуться к ответу" }).click();
    await expect(catalog).toBeVisible();
    await expect(editor(catalog)).toHaveValue("Черновик");

    await editor(catalog).press("Escape");
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "Не сохранять" }).click();
    await expect(editor(catalog)).toHaveCount(0);
    await expect(catalog).toBeVisible();
    await expect(add).toBeFocused();
    await expect(general.getByRole("article")).toHaveCount(2);

    // The page itself asks before it is left with an unsaved draft.
    await add.click();
    await editor(catalog).fill("Ещё черновик");
    const asked = new Promise<string>((resolve) => page.once("dialog", (dialog) => {
      resolve(dialog.type());
      void dialog.dismiss();
    }));
    await page.close({ runBeforeUnload: true });
    expect(await asked).toBe("beforeunload");
  });

  test("closing with an unsaved draft: the window closes after the answer and focus returns to its button", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    const catalog = await openCatalog(page);
    await detail(catalog, "общее").getByRole("button", { name: "Добавить ответ" }).click();
    await editor(catalog).fill("Черновик");
    await catalog.getByRole("button", { name: "Закрыть" }).click();
    await page.getByRole("alertdialog", { name: "Не сохранять изменения?" }).getByRole("button", { name: "Не сохранять" }).click();
    await expect(catalog).toBeHidden();
    await expect(opener(page)).toBeFocused();
    // The next opening starts clean.
    await opener(page).click();
    await expect(detail(catalog, "общее").getByRole("article")).toHaveCount(2);
    await expect(editor(catalog)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(catalog).toBeHidden();
    await expect(opener(page)).toBeFocused();
  });

  test("delete: a confirmation first; cancel keeps the reply, focus moves to the next one after deleting", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    const catalog = await openCatalog(page);
    const general = detail(catalog, "общее");
    await replyAction(page, general, "Спасибо за обращение", "Удалить");
    const confirm = page.getByRole("alertdialog", { name: "Удалить ответ?" });
    await expect(confirm).toContainText("Спасибо за обращение, хорошего дня.");
    await expect(confirm.getByRole("button", { name: "Отмена" })).toBeFocused();
    await confirm.getByRole("button", { name: "Отмена" }).click();
    await expect(confirm).toBeHidden();
    await expect(card(general, "Спасибо за обращение")).toBeVisible();
    await expect(cardMenu(general, "Спасибо за обращение")).toBeFocused();

    await replyAction(page, general, "Здравствуйте! Чем могу", "Удалить");
    await confirm.getByRole("button", { name: "Удалить ответ" }).click();
    await expect(status(catalog)).toHaveText("Ответ удалён.");
    await expect(card(general, "Здравствуйте! Чем могу")).toHaveCount(0);
    await expect(cardMenu(general, "Спасибо за обращение")).toBeFocused();
    expect(await serverReply(page, "g1", "1")).toBeUndefined();
  });

  test("move: the target group is chosen explicitly, cancel returns to the reply, the edit route carries the revision", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await other(page, "reply-groups", { name: "доставка" });
    const catalog = await openCatalog(page);
    // "доставка" comes first by name and opens by itself.
    await expect(group(catalog, "доставка")).toHaveAttribute("aria-selected", "true");
    await group(catalog, "общее").click();
    const general = detail(catalog, "общее");
    await replyAction(page, general, "Спасибо за обращение", "Перенести");
    await expect(catalog.getByRole("heading", { name: "Перенос ответа из #общее" })).toBeVisible();
    await expect(catalog.getByRole("searchbox", { name: "Найти группу для переноса" })).toBeFocused();
    const targets = catalog.getByRole("group", { name: "Куда перенести" });
    // The reply's own group is not offered.
    await expect(targets.getByRole("radio")).toHaveCount(2);
    await catalog.getByRole("searchbox", { name: "Найти группу для переноса" }).fill("опл");
    await expect(targets.getByRole("radio")).toHaveCount(1);
    await catalog.getByRole("button", { name: "Отмена" }).click();
    await expect(general.getByRole("article")).toHaveCount(2);
    await expect(cardMenu(general, "Спасибо за обращение")).toBeFocused();

    await replyAction(page, general, "Спасибо за обращение", "Перенести");
    await catalog.getByRole("button", { name: "Перенести", exact: true }).click();
    await expect(catalog.getByText("Выберите группу, куда перенести ответ.")).toBeVisible();
    await targets.getByRole("radio", { name: "#оплата" }).check();
    const find = catalog.getByRole("searchbox", { name: "Найти группу для переноса" });
    await find.fill("дост");
    await find.press("Enter");
    await expect(targets.getByRole("radio")).toHaveCount(1);
    await expect(catalog.getByRole("heading", { name: "Перенос ответа из #общее" })).toBeVisible();
    expect((await serverReply(page, "g1", "2"))?.text).toBe("Спасибо за обращение, хорошего дня.");
    await find.fill("");
    await expect(targets.getByRole("radio")).toHaveCount(2);
    await expect(targets.getByRole("radio", { name: "#оплата" })).toBeChecked();
    const sent = page.waitForRequest((item) => item.url().endsWith(`${API}/replies/2/edit`));
    await catalog.getByRole("button", { name: "Перенести в #оплата" }).click();
    expect((await sent).postDataJSON()).toEqual({ group_id: "g2", text: "Спасибо за обращение, хорошего дня.", revision: 0 });
    await expect(status(catalog)).toHaveText("Ответ перенесён в #оплата.");
    await expect(general.getByRole("article")).toHaveCount(1);
    await expect(cardMenu(general, "Здравствуйте! Чем могу")).toBeFocused();
    await group(catalog, "оплата").click();
    await expect(detail(catalog, "оплата").getByRole("article")).toHaveCount(2);
    await expect(card(detail(catalog, "оплата"), "Спасибо за обращение")).toBeVisible();
  });

  test("search: across the catalog with each reply's group, inside one group, empty results, and back where it started", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    const asked: string[] = [];
    page.on("request", (item) => {
      const url = new URL(item.url());
      const kind = url.pathname.split("/").pop();
      if (item.method() === "GET" && (kind === "replies" || kind === "reply-groups") && url.searchParams.get("q")) {
        asked.push(`${kind}:${url.searchParams.get("q")}`);
      }
    });
    const catalog = await openCatalog(page);
    await expect(detail(catalog, "общее").getByRole("article")).toHaveCount(2);
    // Typing waits for a pause: one search for the whole word.
    await search(catalog).pressSequentially("спасибо", { delay: 40 });
    const found = results(catalog);
    await expect(found.getByRole("heading", { name: "Поиск: «спасибо»" })).toBeVisible();
    await expect(found.getByRole("article")).toHaveCount(1);
    await expect(found.getByRole("button", { name: "Открыть группу #общее" })).toBeVisible();
    expect(asked.sort()).toEqual(["replies:спасибо", "reply-groups:спасибо"]);

    await search(catalog).fill("опл");
    await expect(found.getByRole("button", { name: "#оплата" })).toBeVisible();
    await expect(found.getByRole("article")).toHaveCount(0);
    await search(catalog).fill("нет такого");
    await expect(found.getByText("Ничего не найдено по запросу «нет такого». Измените запрос или очистите поиск.")).toBeVisible();
    // Clearing returns to the group that was open.
    await catalog.getByRole("button", { name: "Очистить поиск" }).click();
    await expect(search(catalog)).toBeFocused();
    await expect(search(catalog)).toHaveValue("");
    await expect(detail(catalog, "общее").getByRole("article")).toHaveCount(2);
    // Esc in the search clears it instead of closing the window.
    await search(catalog).fill("тариф");
    await expect(found.getByRole("article")).toHaveCount(1);
    await search(catalog).press("Escape");
    await expect(search(catalog)).toHaveValue("");
    await expect(catalog).toBeVisible();
    // A reply's group opens from the result; the search is cleared.
    await search(catalog).fill("тариф");
    await found.getByRole("button", { name: "Открыть группу #оплата" }).click();
    await expect(search(catalog)).toHaveValue("");
    await expect(group(catalog, "оплата")).toHaveAttribute("aria-selected", "true");
    await expect(detail(catalog, "оплата").getByRole("button", { name: "Добавить ответ" })).toBeFocused();
    await search(catalog).fill("опл");
    await found.getByRole("button", { name: "#оплата" }).click();
    await expect(detail(catalog, "оплата")).toBeVisible();

    // Inside the open group only.
    await group(catalog, "общее").click();
    const inGroup = catalog.getByRole("button", { name: "В #общее" });
    await inGroup.click();
    await expect(inGroup).toHaveAttribute("aria-pressed", "true");
    await expect(search(catalog)).toHaveAttribute("placeholder", "Найти в #общее…");
    await search(catalog).fill("спасибо");
    const general = detail(catalog, "общее");
    await expect(general.getByRole("article")).toHaveCount(1);
    await expect(results(catalog)).toHaveCount(0);
    await search(catalog).fill("тариф");
    await expect(general.getByText("В #общее ничего не найдено по запросу «тариф».")).toBeVisible();
    await catalog.getByRole("button", { name: "Весь каталог" }).click();
    await expect(found.getByRole("button", { name: "Открыть группу #оплата" })).toBeVisible();
    await catalog.getByRole("button", { name: "Очистить поиск" }).click();
    await expect(general.getByRole("article")).toHaveCount(2);

    // Edit from the results: the reply keeps its own group.
    await search(catalog).fill("тариф");
    await replyAction(page, found, "Проверьте, пожалуйста", "Изменить");
    await expect(catalog.getByRole("heading", { name: "Изменение ответа в #оплата" })).toBeVisible();
    await expect(search(catalog)).toBeDisabled();
    await editor(catalog).fill("Проверьте, пожалуйста, настройки тарифа в профиле.");
    await catalog.getByRole("button", { name: "Сохранить ответ" }).click();
    await expect(status(catalog)).toHaveText("Ответ сохранён.");
    // The card names a long reply by its first 48 characters.
    await expect(card(found, "Проверьте, пожалуйста, настройки тарифа в профил…")).toBeVisible();
    await expect(cardMenu(found, "Проверьте, пожалуйста, настройки тарифа в профил…")).toBeFocused();
    expect((await serverReply(page, "g2", "3"))?.text).toBe("Проверьте, пожалуйста, настройки тарифа в профиле.");
  });

  test("search: a slow answer to an older query never replaces the newer one; results come 50 at a time", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request, { catalog: "large" });
    const catalog = await openCatalog(page);
    await expect(groupList(catalog).getByRole("option")).toHaveCount(50);
    const slow = (url: URL) => url.pathname.endsWith("/replies") && url.searchParams.get("q") === "Ответ номер 1";
    await page.route(slow, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.continue().catch(() => undefined);
    });
    const settled = Promise.race([
      page.waitForEvent("requestfinished", (item) => slow(new URL(item.url()))),
      page.waitForEvent("requestfailed", (item) => slow(new URL(item.url()))),
    ]);
    await search(catalog).fill("Ответ номер 1");
    await page.waitForRequest((item) => slow(new URL(item.url())));
    await search(catalog).fill("Ответ номер");
    const found = results(catalog);
    await expect(found.getByRole("article")).toHaveCount(50);
    await settled;
    await expect(found.getByRole("heading", { name: "Поиск: «Ответ номер»" })).toBeVisible();
    await expect(found.getByRole("article")).toHaveCount(50);
    // Every result names its group, even one beyond the loaded page of groups.
    await expect(found.getByRole("button", { name: "Открыть группу #общее" })).toHaveCount(50);
    await found.getByRole("button", { name: "Ещё ответы" }).click();
    await expect(found.getByRole("article")).toHaveCount(55);
    await expect(found.getByRole("button", { name: "Ещё ответы" })).toHaveCount(0);

    await search(catalog).fill("группа");
    await expect(found.getByRole("button", { name: /^\#группа_/ })).toHaveCount(50);
    await found.getByRole("button", { name: "Ещё группы" }).click();
    await expect(found.getByRole("button", { name: /^\#группа_/ })).toHaveCount(55);
    // A group from the second page opens from the results.
    await found.getByRole("button", { name: "#группа_55" }).click();
    await expect(detail(catalog, "группа_55")).toBeVisible();
  });

  test("conflicts: another operator's version is shown next to the draft, nothing is overwritten unseen", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    const catalog = await openCatalog(page);
    const general = detail(catalog, "общее");
    await replyAction(page, general, "Здравствуйте! Чем могу", "Изменить");
    await editor(catalog).fill("Добрый день! Чем помочь?");
    await other(page, "replies/1/edit", { group_id: "g1", text: "Приветствуем! Чем можем помочь?", revision: 0 });
    await catalog.getByRole("button", { name: "Сохранить ответ" }).click();
    const theirs = catalog.getByRole("group", { name: "Версия другого оператора" });
    await expect(theirs).toContainText("Приветствуем! Чем можем помочь?");
    await expect(editor(catalog)).toHaveValue("Добрый день! Чем помочь?");
    expect((await serverReply(page, "g1", "1"))?.text).toBe("Приветствуем! Чем можем помочь?");
    await theirs.getByRole("button", { name: "Взять эту версию в поле" }).click();
    await expect(editor(catalog)).toHaveValue("Приветствуем! Чем можем помочь?");
    await editor(catalog).fill("Добрый день! Чем помочь?");
    // A second save replaces their version knowingly.
    await catalog.getByRole("button", { name: "Сохранить ответ" }).click();
    await expect(status(catalog)).toHaveText("Ответ сохранён.");
    expect((await serverReply(page, "g1", "1"))?.text).toBe("Добрый день! Чем помочь?");

    // Deleted meanwhile: the draft can be saved as a new reply.
    await replyAction(page, general, "Спасибо за обращение", "Изменить");
    await editor(catalog).fill("Спасибо! Хорошего дня.");
    await other(page, "replies/2/delete", { revision: 0 });
    await catalog.getByRole("button", { name: "Сохранить ответ" }).click();
    await expect(catalog.getByText(/^Этого ответа больше нет: его удалил или перенёс другой оператор/)).toBeVisible();
    await expect(editor(catalog)).toHaveValue("Спасибо! Хорошего дня.");
    await catalog.getByRole("button", { name: "Добавить ответ" }).click();
    await expect(status(catalog)).toHaveText("Ответ добавлен в #общее.");
    await expect(card(general, "Спасибо! Хорошего дня.")).toBeVisible();

    // Changed before the deletion was confirmed: the fresh text is shown and asked again.
    await replyAction(page, general, "Добрый день", "Удалить");
    const confirm = page.getByRole("alertdialog", { name: "Удалить ответ?" });
    await other(page, "replies/1/edit", { group_id: "g1", text: "Совсем другой текст", revision: (await serverReply(page, "g1", "1"))!.revision });
    await confirm.getByRole("button", { name: "Удалить ответ" }).click();
    await expect(confirm.getByText("Ответ изменил другой оператор: проверьте его текущий текст и подтвердите удаление снова.")).toBeVisible();
    await expect(confirm).toContainText("Совсем другой текст");
    expect(await serverReply(page, "g1", "1")).toBeDefined();
    await confirm.getByRole("button", { name: "Удалить ответ" }).click();
    await expect(status(catalog)).toHaveText("Ответ удалён.");
    expect(await serverReply(page, "g1", "1")).toBeUndefined();

    // A group renamed meanwhile: the typed name stays for another try.
    await other(page, "reply-groups/g2/rename", { name: "платежи", revision: 0 });
    await group(catalog, "оплата").click();
    await groupAction(page, catalog, "оплата", "Переименовать");
    const rename = catalog.getByRole("textbox", { name: "Новое название группы" });
    await rename.fill("#счета");
    await rename.press("Enter");
    await expect(catalog.getByText("Группу изменил другой оператор, сейчас она называется #платежи. Сохраните новое название ещё раз или отмените.")).toBeVisible();
    await expect(rename).toHaveValue("#счета");
    await rename.press("Enter");
    await expect(status(catalog)).toHaveText("Группа переименована: #счета.");
    await expect(group(catalog, "счета")).toHaveAttribute("aria-selected", "true");
    // Renaming changed the replies' revisions: an edit right after it still saves.
    await replyAction(page, detail(catalog, "счета"), "Проверьте, пожалуйста", "Изменить");
    await editor(catalog).fill("Проверьте тариф в настройках.");
    await catalog.getByRole("button", { name: "Сохранить ответ" }).click();
    await expect(status(catalog)).toHaveText("Ответ сохранён.");

    // A reply opened from the search lies in a group other than the open one: its fresh version comes from there.
    await group(catalog, "общее").click();
    await search(catalog).fill("тариф");
    await replyAction(page, results(catalog), "Проверьте тариф", "Изменить");
    await expect(catalog.getByRole("heading", { name: "Изменение ответа в #счета" })).toBeVisible();
    await editor(catalog).fill("Тариф меняется в настройках профиля.");
    await other(page, "replies/3/edit", { group_id: "g2", text: "Тариф — в разделе «Оплата».", revision: (await serverReply(page, "g2", "3"))!.revision });
    await catalog.getByRole("button", { name: "Сохранить ответ" }).click();
    await expect(catalog.getByRole("group", { name: "Версия другого оператора" })).toContainText("Тариф — в разделе «Оплата».");
    await expect(editor(catalog)).toHaveValue("Тариф меняется в настройках профиля.");
  });

  for (const mode of ["create", "edit"] as const) {
    test(`saving ${mode}: the submitted text stays readonly until the slow request completes`, async ({ page, context, request, consoleErrors }) => {
      void consoleErrors;
      await start(page, context, request);
      const catalog = await openCatalog(page);
      const general = detail(catalog, "общее");
      if (mode === "create") await general.getByRole("button", { name: "Добавить ответ" }).click();
      else await replyAction(page, general, "Здравствуйте! Чем могу помочь?", "Изменить");
      const field = editor(catalog);
      await field.fill("Текст для сохранения");
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      await page.route(mode === "create" ? `**${API}/replies` : `**${API}/replies/1/edit`, async (route) => {
        await pending;
        await route.fallback();
      }, { times: 1 });
      try {
        await catalog.locator('form button[type="submit"]').click();
        await expect(field).toHaveJSProperty("readOnly", true);
        await expect(field).toBeEnabled();
        await field.focus();
        await page.keyboard.press("End");
        await page.keyboard.type(" accidental unsaved change");
        await expect(field).toHaveValue("Текст для сохранения");
        await expect(field).toBeFocused();
      } finally {
        release();
      }
      await expect(field).toHaveCount(0);
      await expect(card(general, "Текст для сохранения")).toBeVisible();
    });
  }

  test("errors: a failed save keeps the draft, a repeated click sends once, a failed refresh does not undo a save", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    const catalog = await openCatalog(page);
    const general = detail(catalog, "общее");
    await general.getByRole("button", { name: "Добавить ответ" }).click();
    await editor(catalog).fill("Ответ при сбое");
    const save = catalog.locator('form button[type="submit"]');
    const create = `**${API}/replies`;
    await page.route(create, (route) => route.fulfill(failWith(500, "Ошибка сервера.")), { times: 1 });
    await save.click();
    await expect(catalog.getByText("Ошибка сервера.")).toBeVisible();
    await expect(editor(catalog)).toHaveValue("Ответ при сбое");
    await page.route(create, (route) => route.abort("failed"), { times: 1 });
    await save.click();
    await expect(catalog.getByText("Нет связи с сервером.")).toBeVisible();
    await expect(editor(catalog)).toHaveValue("Ответ при сбое");
    await page.route(create, (route) => route.fulfill(failWith(403, "Нет доступа к проекту.")), { times: 1 });
    await save.click();
    await expect(catalog.getByText("Нет доступа к проекту.")).toBeVisible();
    await expect(editor(catalog)).toHaveValue("Ответ при сбое");

    // The save goes through, the list does not reload: the save is reported, the list offers a retry.
    const list = (url: URL) => url.pathname === `${API}/replies` && url.searchParams.get("group_id") === "g1";
    await page.route(list, (route) => route.fulfill(failWith(500, "Ошибка сервера.")), { times: 1 });
    await page.route(create, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.fallback();
    }, { times: 1 });
    await save.click();
    await expect(save).toHaveText("Сохраняем…");
    await save.click({ force: true });
    await save.click({ force: true });
    await expect(status(catalog)).toHaveText("Ответ добавлен в #общее.");
    expect((await stubLog(request)).filter((entry) => entry.method === "POST" && entry.path === `${API}/replies`)).toHaveLength(1);
    await expect(general.getByText("Ошибка сервера.")).toBeVisible();
    await general.getByRole("button", { name: "Повторить" }).click();
    await expect(card(general, "Ответ при сбое")).toBeVisible();
    await expect(general.getByRole("article")).toHaveCount(3);
  });

  test("a group deleted by another operator: the draft stays, the catalog returns to the groups", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    const catalog = await openCatalog(page);
    await group(catalog, "оплата").click();
    await detail(catalog, "оплата").getByRole("button", { name: "Добавить ответ" }).click();
    await editor(catalog).fill("Новый ответ про оплату");
    // Another operator empties the group and deletes it.
    await other(page, "replies/3/edit", { group_id: "g1", text: "Проверьте, пожалуйста, настройки тарифа.", revision: 0 });
    await other(page, "reply-groups/g2/delete", { revision: (await serverGroup(page, "оплата")).revision });
    await catalog.getByRole("button", { name: "Добавить ответ" }).click();
    await expect(catalog.getByText(/^Группы #оплата больше нет: её удалил другой оператор. Скопируйте текст/)).toBeVisible();
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest("form")?.querySelector("textarea")))).toBe(true);
    await expect(editor(catalog)).toHaveValue("Новый ответ про оплату");
    await expect(group(catalog, "оплата")).toHaveCount(0);
    await catalog.getByRole("button", { name: "Отмена" }).click();
    await page.getByRole("alertdialog", { name: "Не сохранять изменения?" }).getByRole("button", { name: "Не сохранять" }).click();
    await expect(groupList(catalog).getByRole("option")).toHaveText(["#общее"]);
    await expect(groupList(catalog).getByRole("option").first()).toBeFocused();
  });

  test("project access changes while the catalog is open: it closes, the next project shows its own catalog", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    const catalog = await openCatalog(page);
    await detail(catalog, "общее").getByRole("button", { name: "Добавить ответ" }).click();
    await editor(catalog).fill("Черновик");
    await expect.poll(async () => (await (await request.get("/__stub/streams?project=p1")).json()).open).toBe(1);
    await request.post("/__stub/revoke", { data: { project: "p1", status: 403 } });
    await expect(catalog).toBeHidden();
    await expect(page.getByRole("alert")).toHaveText("Доступ к проекту изменился. Выберите доступный проект.");
    await page.getByRole("button", { name: /^Текущий проект/ }).click();
    await page.getByRole("menuitemradio", { name: "Второй проект" }).click();
    await expect(page.getByRole("button", { name: /^Текущий проект/ })).toHaveAccessibleName("Текущий проект Второй проект");
    const second = await openCatalog(page);
    await expect(second.getByText("Групп пока нет. Создайте первую группу, чтобы добавить в неё ответы.")).toBeVisible();
    await expect(second.getByText("Создайте первую группу: ответы хранятся в группах.")).toBeVisible();
    await expect(editor(second)).toHaveCount(0);
    await expect(second.getByRole("group", { name: "Где искать" })).toHaveCount(0);
  });

  test("keyboard: the groups are one stop with arrows, menus open with Enter, Esc steps back one level", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await opener(page).focus();
    await page.keyboard.press("Enter");
    const catalog = page.getByRole("dialog", { name: "Готовые ответы" });
    await expect(detail(catalog, "общее").getByRole("article")).toHaveCount(2);
    await catalog.getByRole("button", { name: "Новая группа" }).focus();
    await page.keyboard.press("Tab");
    await expect(group(catalog, "общее")).toBeFocused();
    expect(await group(catalog, "общее").evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
    await page.keyboard.press("ArrowDown");
    await expect(group(catalog, "оплата")).toBeFocused();
    await expect(group(catalog, "общее")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(group(catalog, "оплата")).toHaveAttribute("aria-selected", "true");
    await expect(detail(catalog, "оплата").getByRole("article")).toHaveCount(1);

    await page.keyboard.press("Tab");
    const groupMenu = catalog.getByRole("button", { name: "Действия с группой #оплата" });
    await expect(groupMenu).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Переименовать" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(groupMenu).toBeFocused();
    await expect(catalog).toBeVisible();

    await page.keyboard.press("Tab");
    await expect(detail(catalog, "оплата").getByRole("button", { name: "Добавить ответ" })).toBeFocused();
    await page.keyboard.press("Tab");
    const menu = cardMenu(detail(catalog, "оплата"), "Проверьте, пожалуйста");
    await expect(menu).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Изменить" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(editor(catalog)).toBeFocused();
    // Esc leaves an untouched editor, then the window.
    await page.keyboard.press("Escape");
    await expect(editor(catalog)).toHaveCount(0);
    await expect(menu).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(catalog).toBeHidden();
    await expect(opener(page)).toBeFocused();
  });

  test("phone 375px: groups, then a group, then the editor, each with a way back", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await page.setViewportSize({ width: 375, height: 812 });
    await start(page, context, request);
    await other(page, "reply-groups", { name: "очень_длинное_название_группы_про_возврат_товара" });
    const catalog = await openCatalog(page);
    const frame = await box(catalog);
    expect(Math.round(frame.width)).toBe(375);
    expect(Math.round(frame.height)).toBe(812);
    const nav = groupNav(catalog);
    await expect(nav).toBeVisible();
    await expect(detail(catalog, "общее")).toBeHidden();
    await expectNoSidewaysScroll(page, catalog, 375);
    await expectApart(search(catalog), catalog.getByRole("group", { name: "Где искать" }), nav);
    await expectInside(group(catalog, "очень_длинное_название_группы_про_возврат_товара"), nav);

    await group(catalog, "общее").click();
    const general = detail(catalog, "общее");
    await expect(general).toBeVisible();
    await expect(nav).toBeHidden();
    await expectApart(general.getByRole("button", { name: "К списку групп" }), general.getByRole("heading", { name: "#общее" }),
      general.getByRole("button", { name: "Действия с группой #общее" }), general.getByRole("button", { name: "Добавить ответ" }));
    await expectInside(general.getByRole("button", { name: "Добавить ответ" }), catalog);
    await expectInside(card(general, "Здравствуйте! Чем могу"), catalog);
    await expectNoSidewaysScroll(page, catalog, 375);

    await general.getByRole("button", { name: "К списку групп" }).click();
    await expect(nav).toBeVisible();
    await expect(group(catalog, "общее")).toHaveAttribute("aria-selected", "true");
    // The open group opens again with a tap.
    await group(catalog, "общее").click();
    await expect(general).toBeVisible();

    await general.getByRole("button", { name: "Добавить ответ" }).click();
    await expect(editor(catalog)).toBeInViewport();
    await expectApart(catalog.getByRole("button", { name: "Назад к ответам группы" }), catalog.getByRole("heading", { name: "Новый ответ в #общее" }));
    await expectApart(editor(catalog), catalog.getByRole("button", { name: "Отмена" }), catalog.locator('form button[type="submit"]'));
    await expect(catalog.locator('form button[type="submit"]')).toBeInViewport();
    await catalog.getByRole("button", { name: "Назад к ответам группы" }).click();
    await expect(general).toBeVisible();

    // A search started from the groups returns to them when cleared.
    await general.getByRole("button", { name: "К списку групп" }).click();
    await search(catalog).fill("спасибо");
    await expect(results(catalog).getByRole("article")).toHaveCount(1);
    await expect(nav).toBeHidden();
    await expectNoSidewaysScroll(page, catalog, 375);
    await catalog.getByRole("button", { name: "Очистить поиск" }).click();
    await expect(nav).toBeVisible();

    // A long group name is cut, never pushes the buttons off the screen.
    await group(catalog, "очень_длинное_название_группы_про_возврат_товара").click();
    const long = detail(catalog, "очень_длинное_название_группы_про_возврат_товара");
    await expectInside(long.getByRole("button", { name: "Добавить ответ" }), catalog);
    await expectApart(long.getByRole("heading"), long.getByRole("button", { name: /^Действия с группой/ }), long.getByRole("button", { name: "Добавить ответ" }));
    await expectNoSidewaysScroll(page, catalog, 375);
  });

  test("a group created while a reply is being edited asks before the draft is left", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    const catalog = await openCatalog(page);
    await catalog.getByRole("button", { name: "Новая группа" }).click();
    await replyAction(page, detail(catalog, "общее"), "Спасибо за обращение", "Изменить");
    await editor(catalog).fill("Спасибо! Черновик.");
    const name = catalog.getByRole("textbox", { name: "Новая группа" });
    await name.fill("promo");
    await name.press("Enter");
    const discard = page.getByRole("alertdialog", { name: "Не сохранять изменения?" });
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "Вернуться к ответу" }).click();
    // The group is created, the draft and its group stay.
    await expect(editor(catalog)).toHaveValue("Спасибо! Черновик.");
    await expect(editor(catalog)).toBeFocused();
    await expect(group(catalog, "promo")).toBeVisible();
    await expect(group(catalog, "общее")).toHaveAttribute("aria-selected", "true");

    await catalog.getByRole("button", { name: "Новая группа" }).click();
    await name.fill("promo_2");
    await name.press("Enter");
    await discard.getByRole("button", { name: "Не сохранять" }).click();
    await expect(group(catalog, "promo_2")).toHaveAttribute("aria-selected", "true");
    await expect(detail(catalog, "promo_2").getByRole("button", { name: "Добавить ответ" })).toBeFocused();
    expect((await serverReply(page, "g1", "2"))?.text).toBe("Спасибо за обращение, хорошего дня.");
  });

  test("a group beyond the loaded pages changed by another operator: its current name and revision are found", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request, { catalog: "large" });
    await other(page, "reply-groups", { name: "яблоко" });
    const catalog = await openCatalog(page);
    await expect(groupList(catalog).getByRole("option")).toHaveCount(50);
    await search(catalog).fill("ябл");
    await results(catalog).getByRole("button", { name: "#яблоко" }).click();
    await expect(detail(catalog, "яблоко")).toBeVisible();
    const apple = await serverGroup(page, "яблоко");
    await other(page, `reply-groups/${apple.id}/rename`, { name: "яблоки", revision: apple.revision });

    await groupAction(page, catalog, "яблоко", "Переименовать");
    const rename = catalog.getByRole("textbox", { name: "Новое название группы" });
    await rename.fill("/фрукты");
    await rename.press("Enter");
    await expect(catalog.getByText("Группу изменил другой оператор, сейчас она называется #яблоки. Сохраните новое название ещё раз или отмените.")).toBeVisible();
    await rename.press("Escape");
    await expect(detail(catalog, "яблоки")).toBeVisible();

    await other(page, `reply-groups/${apple.id}/rename`, { name: "груши", revision: (await serverGroup(page, "яблоки")).revision });
    await groupAction(page, catalog, "яблоки", "Удалить группу");
    await page.getByRole("alertdialog", { name: "Удалить группу #яблоки?" }).getByRole("button", { name: "Удалить группу" }).click();
    const again = page.getByRole("alertdialog", { name: "Удалить группу #груши?" });
    await expect(again.getByText("Группу изменил другой оператор: проверьте её и подтвердите удаление снова.")).toBeVisible();
    await again.getByRole("button", { name: "Удалить группу" }).click();
    await expect(status(catalog)).toHaveText("Группа #груши удалена.");
    await expect.poll(async () => (await (await page.request.get(`${API}/reply-groups?q=груши`)).json()).length).toBe(0);
  });

  test("a search typed before the groups arrive is kept", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    const groupsPage = (url: URL) => url.pathname === `${API}/reply-groups` && !url.searchParams.get("q");
    await page.route(groupsPage, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    }, { times: 1 });
    const catalog = await openCatalog(page);
    await search(catalog).fill("спасибо");
    await expect(results(catalog).getByRole("article")).toHaveCount(1);
    await expect(groupList(catalog).getByRole("option")).toHaveCount(2);
    await expect(search(catalog)).toHaveValue("спасибо");
    await expect(results(catalog).getByRole("article")).toHaveCount(1);
  });

  test("phone keyboard: focus follows the level that is shown and stays in the window", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await page.setViewportSize({ width: 375, height: 812 });
    await start(page, context, request);
    await other(page, "reply-groups", { name: "ярлыки" });
    const catalog = await openCatalog(page);
    await expect(group(catalog, "общее")).toHaveAttribute("aria-selected", "true");
    await group(catalog, "общее").focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const payment = detail(catalog, "оплата");
    await expect(payment.getByRole("button", { name: "Добавить ответ" })).toBeFocused();
    await payment.getByRole("button", { name: "К списку групп" }).press("Enter");
    await expect(group(catalog, "оплата")).toBeFocused();
    const inWindow = () => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));
    for (let step = 0; step < 6; step++) {
      await page.keyboard.press("Tab");
      expect(await inWindow()).toBe(true);
    }
    // After taps the arrows still continue from the open group, not from the top of the list.
    await group(catalog, "оплата").click();
    await expect(payment.getByRole("button", { name: "Добавить ответ" })).toBeFocused();
    await payment.getByRole("button", { name: "К списку групп" }).click();
    await expect(group(catalog, "оплата")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(group(catalog, "ярлыки")).toBeFocused();
  });

  test("long replies: six lines in the card, the rest opens in place; short ones have no toggle", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await page.setViewportSize({ width: 1280, height: 800 });
    await start(page, context, request);
    await other(page, "replies", { group_id: "g1", text: lines("Строка", 6) });
    await other(page, "replies", { group_id: "g1", text: lines("Пункт", 7) });
    await other(page, "replies", { group_id: "g1", text: `Слово${"д".repeat(700)}` });
    const catalog = await openCatalog(page);
    const general = detail(catalog, "общее");
    await expect(general.getByRole("article")).toHaveCount(5);
    // A short reply and exactly six lines fit: no toggle.
    await expect(card(general, "Здравствуйте! Чем могу").getByRole("button", { name: /полностью|Свернуть/ })).toHaveCount(0);
    await expect(card(general, "Строка 1").getByRole("button", { name: /полностью|Свернуть/ })).toHaveCount(0);

    const seven = card(general, "Пункт 1");
    const show = showWhole(general, "Пункт 1");
    await expect(show).toBeVisible();
    await expect(show).toHaveAttribute("aria-expanded", "false");
    // The visible label is short; the hidden word completes the name for a screen reader.
    await expect(show.locator(".sr-only")).toHaveText("ответ");
    const body = await replyText(general, "Пункт 1");
    expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight + 1)).toBe(true);
    const collapsed = (await box(seven)).height;
    // The toggle sits at the bottom right, away from the "⋯" menu at the top right.
    const [toggleBox, menuBox, cardBox] = [await box(show), await box(cardMenu(general, "Пункт 1")), await box(seven)];
    expect(toggleBox.y).toBeGreaterThan(menuBox.y + menuBox.height);
    expect(cardBox.x + cardBox.width - (toggleBox.x + toggleBox.width)).toBeLessThan(80);

    await show.click();
    const hide = collapse(general, "Пункт 1");
    await expect(hide).toBeFocused();
    await expect(hide).toHaveAttribute("aria-expanded", "true");
    expect(await body.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    expect(await body.evaluate((element) => getComputedStyle(element).overflowY)).toBe("visible");
    expect((await box(seven)).height).toBeGreaterThan(collapsed + 15);
    await hide.click();
    await expect(showWhole(general, "Пункт 1")).toBeFocused();
    await expect.poll(async () => Math.round((await box(seven)).height)).toBe(Math.round(collapsed));

    // Space and Enter work; the long word wraps and opens too; several cards stay open at once.
    await page.keyboard.press("Space");
    await expect(collapse(general, "Пункт 1")).toHaveAttribute("aria-expanded", "true");
    const word = showWhole(general, "Слово");
    await word.focus();
    await page.keyboard.press("Enter");
    await expect(collapse(general, "Слово")).toHaveAttribute("aria-expanded", "true");
    await expect(collapse(general, "Пункт 1")).toHaveAttribute("aria-expanded", "true");
    expect(await (await replyText(general, "Слово")).evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expectNoSidewaysScroll(page, catalog, 1280);

    // Another group and back: every card starts collapsed again.
    await group(catalog, "оплата").click();
    await group(catalog, "общее").click();
    await expect(showWhole(general, "Пункт 1")).toHaveAttribute("aria-expanded", "false");
    await expect(showWhole(general, "Слово")).toHaveAttribute("aria-expanded", "false");

    // In search results too, and a new result does not inherit the state.
    await search(catalog).fill("Пункт");
    const found = results(catalog);
    await showWhole(found, "Пункт 1").click();
    await expect(collapse(found, "Пункт 1")).toHaveAttribute("aria-expanded", "true");
    await search(catalog).fill("Строка");
    await expect(card(found, "Строка 1")).toBeVisible();
    await expect(found.getByRole("article")).toHaveCount(1);
    await expect(card(found, "Строка 1").getByRole("button", { name: /полностью|Свернуть/ })).toHaveCount(0);
    await search(catalog).fill("Пункт");
    await expect(showWhole(found, "Пункт 1")).toHaveAttribute("aria-expanded", "false");
  });

  test("long replies: the width decides, and collapsing a tall card keeps it in view", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await page.setViewportSize({ width: 1280, height: 800 });
    await start(page, context, request);
    const paragraph = "Чтобы сменить тариф, откройте раздел настроек и выберите подходящий вариант. ".repeat(3).trim();
    await other(page, "replies", { group_id: "g1", text: paragraph });
    await other(page, "replies", { group_id: "g1", text: lines("Абзац длинного ответа", 60) });
    const catalog = await openCatalog(page);
    await group(catalog, "общее").click();
    const general = detail(catalog, "общее");
    await expect(general.getByRole("article")).toHaveCount(4);
    // Five lines wide, more than six narrow: the toggle follows the width.
    await expect(card(general, "Чтобы сменить").getByRole("button", { name: /полностью|Свернуть/ })).toHaveCount(0);
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(showWhole(general, "Чтобы сменить")).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(card(general, "Чтобы сменить").getByRole("button", { name: /полностью|Свернуть/ })).toHaveCount(0);

    // A 60-line card opened and read to its end: collapsing brings its top back into view.
    const tall = card(general, "Абзац длинного ответа 1");
    await showWhole(general, "Абзац длинного ответа 1").click();
    const hide = collapse(general, "Абзац длинного ответа 1");
    await hide.scrollIntoViewIfNeeded();
    const scroller = general.locator(".catalog-scroll");
    expect((await box(tall)).y).toBeLessThan((await box(scroller)).y);
    await hide.click();
    await expect(showWhole(general, "Абзац длинного ответа 1")).toBeFocused();
    await expect.poll(async () => (await box(tall)).y).toBeGreaterThanOrEqual((await box(scroller)).y - 1);
    await expect(showWhole(general, "Абзац длинного ответа 1")).toBeInViewport();

    // On a phone the card opens the same way and nothing scrolls sideways.
    await page.setViewportSize({ width: 375, height: 812 });
    await showWhole(general, "Чтобы сменить").click();
    await expect(collapse(general, "Чтобы сменить")).toHaveAttribute("aria-expanded", "true");
    await expectNoSidewaysScroll(page, catalog, 375);
  });

  test("notices: a success disappears by itself, a warning and a conflict stay, nothing keeps empty room", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await page.clock.install();
    await start(page, context, request);
    const catalog = await openCatalog(page);
    const general = detail(catalog, "общее");
    await expect(general.getByRole("article")).toHaveCount(2);
    const area = catalog.locator(".catalog-body");
    const toolbar = catalog.locator(".catalog-toolbar");
    // Measured once the window has finished appearing.
    await catalog.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    const top = (await box(area)).y;
    // No room is kept for a notice.
    expect(top - ((await box(toolbar)).y + (await box(toolbar)).height)).toBeLessThanOrEqual(13);

    await replyAction(page, general, "Здравствуйте! Чем могу", "Удалить");
    await page.getByRole("alertdialog", { name: "Удалить ответ?" }).getByRole("button", { name: "Удалить ответ" }).click();
    await expect(status(catalog)).toHaveText("Ответ удалён.");
    await expect(catalog.getByRole("status").filter({ hasText: "Ответ удалён." })).toHaveCount(1);
    await expect(catalog.getByRole("alert")).toHaveCount(0);
    expect((await box(area)).y).toBe(top);
    expect(await status(catalog).evaluate((element) => getComputedStyle(element.parentElement!).pointerEvents)).toBe("none");
    await expectApart(status(catalog), catalog.getByRole("button", { name: "Закрыть" }), search(catalog), catalog.getByRole("group", { name: "Где искать" }));

    // A second success gets the full time again; the first one's timer does not remove it.
    await page.clock.runFor(2500);
    await general.getByRole("button", { name: "Добавить ответ" }).click();
    await editor(catalog).fill("Новый ответ");
    await catalog.locator('form button[type="submit"]').click();
    await expect(status(catalog)).toHaveText("Ответ добавлен в #общее.");
    await page.clock.runFor(2500);
    await expect(status(catalog)).toHaveText("Ответ добавлен в #общее.");
    await page.clock.runFor(1200);
    await expect(status(catalog)).toHaveCount(0);
    expect((await box(area)).y).toBe(top);

    // A reply already deleted by another operator: a warning that stays until the next step.
    await other(page, "replies/2/delete", { revision: 0 });
    await replyAction(page, general, "Спасибо за обращение", "Удалить");
    await page.getByRole("alertdialog", { name: "Удалить ответ?" }).getByRole("button", { name: "Удалить ответ" }).click();
    await expect(warningNotice(catalog)).toHaveText("Этого ответа уже нет: его удалил или перенёс другой оператор.");
    await expect(warningNotice(catalog)).toHaveAttribute("role", "alert");
    await page.clock.runFor(10_000);
    await expect(warningNotice(catalog)).toBeVisible();
    await general.getByRole("button", { name: "Добавить ответ" }).click();
    await expect(warningNotice(catalog)).toHaveCount(0);

    // A revision conflict in the editor is not touched by the success timer.
    await editor(catalog).fill("Черновик");
    await catalog.getByRole("button", { name: "Отмена" }).click();
    await page.getByRole("alertdialog", { name: "Не сохранять изменения?" }).getByRole("button", { name: "Не сохранять" }).click();
    await replyAction(page, general, "Новый ответ", "Изменить");
    await editor(catalog).fill("Мой вариант");
    const fresh = await serverReply(page, "g1", "4");
    await other(page, "replies/4/edit", { group_id: "g1", text: "Вариант коллеги", revision: fresh!.revision });
    await catalog.getByRole("button", { name: "Сохранить ответ" }).click();
    const theirs = catalog.getByRole("group", { name: "Версия другого оператора" });
    await expect(theirs).toContainText("Вариант коллеги");
    await page.clock.runFor(10_000);
    await expect(theirs).toBeVisible();
    await expect(editor(catalog)).toHaveValue("Мой вариант");
    await catalog.getByRole("button", { name: "Сохранить ответ" }).click();
    await expect(status(catalog)).toHaveText("Ответ сохранён.");

    // Closing the window ends the notice; the next opening starts without it.
    await page.keyboard.press("Escape");
    await expect(catalog).toBeHidden();
    await opener(page).click();
    await expect(detail(catalog, "общее").getByRole("article")).toHaveCount(1);
    await expect(status(catalog)).toHaveCount(0);
    await page.clock.runFor(5000);
    await expect(status(catalog)).toHaveCount(0);
  });

  test("notices on a phone: the toast stays clear of the close button and the search", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await page.setViewportSize({ width: 375, height: 812 });
    await page.clock.install();
    await start(page, context, request);
    const catalog = await openCatalog(page);
    await group(catalog, "общее").click();
    const general = detail(catalog, "общее");
    await replyAction(page, general, "Спасибо за обращение", "Удалить");
    await page.getByRole("alertdialog", { name: "Удалить ответ?" }).getByRole("button", { name: "Удалить ответ" }).click();
    await expect(status(catalog)).toHaveText("Ответ удалён.");
    await expectInside(status(catalog), catalog);
    await expectApart(status(catalog), catalog.getByRole("button", { name: "Закрыть" }), search(catalog));
    await expectNoSidewaysScroll(page, catalog, 375);
    await page.clock.runFor(4000);
    await expect(status(catalog)).toHaveCount(0);
  });

  test("screenshots: long replies and a success notice, desktop and phone, light and dark", async ({ page, context, request, consoleErrors, attachScreenshot }) => {
    void consoleErrors;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.clock.install();
    await start(page, context, request);
    await other(page, "replies", { group_id: "g1", text: "Здравствуйте!\nЧтобы сменить тариф, откройте «Настройки» → «Тариф» и выберите подходящий. Новый тариф начнёт действовать со следующего расчётного периода.\nЕсли что-то не получится, напишите нам — поможем.\nСписок тарифов:\n— «Старт» для одного оператора;\n— «Команда» до десяти операторов;\n— «Компания» без ограничений.\nОплата списывается в начале месяца." });
    const shoot = async (name: string) => {
      await page.mouse.move(0, 0);
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        await attachScreenshot(`catalog-${name}-${theme}.png`);
      }
    };
    const catalog = await openCatalog(page);
    const general = detail(catalog, "общее");
    await expect(showWhole(general, "Здравствуйте! Чтобы сменить")).toBeVisible();
    await shoot("desktop-reply-collapsed");
    await showWhole(general, "Здравствуйте! Чтобы сменить").click();
    await shoot("desktop-reply-expanded");
    await replyAction(page, general, "Спасибо за обращение", "Удалить");
    await page.getByRole("alertdialog", { name: "Удалить ответ?" }).getByRole("button", { name: "Удалить ответ" }).click();
    await expect(status(catalog)).toHaveText("Ответ удалён.");
    await shoot("desktop-notice");

    await page.keyboard.press("Escape");
    await expect(catalog).toBeHidden();
    await page.setViewportSize({ width: 375, height: 812 });
    await openCatalog(page);
    await group(catalog, "общее").click();
    await expect(showWhole(general, "Здравствуйте! Чтобы сменить")).toBeVisible();
    await shoot("phone-reply-collapsed");
    await showWhole(general, "Здравствуйте! Чтобы сменить").click();
    await shoot("phone-reply-expanded");
    await collapse(general, "Здравствуйте! Чтобы сменить").click();
    await general.getByRole("button", { name: "Добавить ответ" }).click();
    await editor(catalog).fill("Спасибо, что написали!");
    await catalog.locator('form button[type="submit"]').click();
    await expect(status(catalog)).toHaveText("Ответ добавлен в #общее.");
    await shoot("phone-notice");
  });

  test("screenshots: desktop and phone, light and dark", async ({ page, context, request, consoleErrors, attachScreenshot }) => {
    void consoleErrors;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await start(page, context, request);
    await other(page, "replies", { group_id: "g1", text: "Здравствуйте!\nЧтобы сменить тариф, откройте «Настройки» → «Тариф» и выберите подходящий. Новый тариф начнёт действовать со следующего расчётного периода.\nЕсли что-то не получится, напишите нам — поможем." });
    await other(page, "reply-groups", { name: "доставка" });
    await other(page, "reply-groups", { name: "очень_длинное_название_группы_про_возврат_товара" });
    const shoot = async (name: string) => {
      await page.mouse.move(0, 0);
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        await attachScreenshot(`catalog-${name}-${theme}.png`);
      }
    };
    const catalog = await openCatalog(page);
    await group(catalog, "общее").click();
    const general = detail(catalog, "общее");
    await expect(general.getByRole("article")).toHaveCount(3);
    await shoot("desktop-group");
    await replyAction(page, general, "Здравствуйте! Чтобы сменить", "Изменить");
    await expect(editor(catalog)).toBeFocused();
    await shoot("desktop-editor");
    await catalog.getByRole("button", { name: "Отмена" }).click();
    await search(catalog).fill("тариф");
    await expect(results(catalog).getByRole("article")).toHaveCount(2);
    await shoot("desktop-search");
    await catalog.getByRole("button", { name: "Очистить поиск" }).click();
    await catalog.getByRole("button", { name: "Новая группа" }).click();
    await shoot("desktop-new-group");
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 375, height: 812 });
    await page.keyboard.press("Escape");
    await expect(catalog).toBeHidden();
    await openCatalog(page);
    await expect(groupNav(catalog)).toBeVisible();
    await shoot("phone-groups");
    await group(catalog, "общее").click();
    await expect(general.getByRole("article")).toHaveCount(3);
    await shoot("phone-group");
    await general.getByRole("button", { name: "Добавить ответ" }).click();
    await expect(editor(catalog)).toBeFocused();
    await shoot("phone-editor");
  });
});
