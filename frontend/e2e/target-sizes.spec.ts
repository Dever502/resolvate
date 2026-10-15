import type { APIRequestContext, BrowserContext, Locator, Page } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, test } from "./fixtures";

// Hit areas of the console's compact controls on the production build: icon-only buttons (ui/IconButton.vue), the
// ways to close, remove, clear and go back, the "⋯" menus (ui/ActionMenu.vue), the menu buttons of the project and of
// the dialogue's folder (ui/MenuSelect.vue), the toggle of a long reply and the buttons of the app bar, the reply box
// and the windows (ui/ModalDialog.vue). Each one is at least 44×44 CSS px whatever the pointer, 48×48 for a coarse
// pointer where it is a frequent touch action with room for it; it lies wholly on the screen, takes the pointer at
// every point of its box (getBoundingClientRect(), elementFromPoint() and a click or a tap near a corner) and
// overlaps no other control. Screens: a desktop, phones with a mouse and with touch, touch on the tablet and desktop
// layouts, and browser zoom (the viewport of a 1280×800 window at 150 and 200 %).
// Every test also fails on a CSP violation or a console error (fixtures.ts).
const SCREENS = [
  { name: "desktop", viewport: { width: 1280, height: 800 } },
  { name: "phone 375 px with a mouse", viewport: { width: 375, height: 812 } },
  { name: "phone 320 px with a mouse", viewport: { width: 320, height: 568 } },
  { name: "touch phone 375 px", viewport: { width: 375, height: 812 }, hasTouch: true },
  { name: "touch phone 320 px", viewport: { width: 320, height: 568 }, hasTouch: true },
  { name: "touch tablet 768 px", viewport: { width: 768, height: 1024 }, hasTouch: true },
  { name: "touch on the desktop layout", viewport: { width: 1280, height: 800 }, hasTouch: true },
  { name: "zoom 150 %", viewport: { width: 853, height: 533 }, deviceScaleFactor: 1.5 },
  { name: "zoom 200 %", viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 },
  { name: "phone 375 px, DejaVu Sans", viewport: { width: 375, height: 812 }, font: "DejaVu Sans" },
  { name: "phone 320 px, DejaVu Sans", viewport: { width: 320, height: 568 }, font: "DejaVu Sans" },
  { name: "touch phone 375 px, DejaVu Sans", viewport: { width: 375, height: 812 }, font: "DejaVu Sans", hasTouch: true },
  { name: "touch phone 320 px, DejaVu Sans", viewport: { width: 320, height: 568 }, font: "DejaVu Sans", hasTouch: true },
] as const;

// What else takes the pointer on a page.
const CONTROLS = [
  "button", "a[href]", "input:not([type=hidden])", "textarea", "select", "summary", "[role=button]", "[role=tab]",
  "[role=option]", "[role^=menuitem]", "[role=radio]", "[role=checkbox]", "[role=combobox]",
  "[role=separator][tabindex]", "[tabindex='0']",
].join(", ");

interface Found {
  width: number;
  height: number;
  /** Edges of the box past the viewport. */
  outside: string[];
  /** Points of the box where another element takes the pointer. */
  missed: string[];
  /** Other controls on the screen whose boxes the box overlaps. */
  overlaps: string[];
  /** How far the box reaches over the text of the field it sits in, in px. */
  overText: number;
}

/**
 * Runs in the page. Probes the centre, the middle of each edge 1 px in and each corner as far in as its rounding (a
 * rounded corner takes no pointer outside its curve). Other controls count when the pointer reaches them at their
 * centre: hidden ones and ones under a window do not. A control inside a field (`field`, a selector) may overlap
 * the field's padding, not its text.
 */
function inspect(element: Element, { selector, field }: { selector: string; field: string | null }): Found {
  const describe = (node: Element | null): string => {
    if (!node) return "nothing";
    const name = node.getAttribute("aria-label") ?? node.textContent?.trim().slice(0, 40) ?? "";
    return `<${node.tagName.toLowerCase()} class="${node.getAttribute("class") ?? ""}"> ${name}`;
  };
  const owns = (node: Element | null): boolean => node !== null && (node === element || element.contains(node));
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const radius = Math.max(...[style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius,
    style.borderBottomRightRadius].map((value) => Number.parseFloat(value) || 0));
  const corner = Math.ceil(radius * 0.3) + 2;
  const { left, top, right, bottom } = rect;
  const x = (left + right) / 2;
  const y = (top + bottom) / 2;
  const points: [string, number, number][] = [
    ["centre", x, y], ["top", x, top + 1], ["bottom", x, bottom - 1], ["left", left + 1, y], ["right", right - 1, y],
    ["top left", left + corner, top + corner], ["top right", right - corner, top + corner],
    ["bottom left", left + corner, bottom - corner], ["bottom right", right - corner, bottom - corner],
  ];
  const missed = points.flatMap(([where, px, py]) => {
    const hit = document.elementFromPoint(px, py);
    return owns(hit) ? [] : [`${where}: ${describe(hit)}`];
  });
  const outside = [
    ...(left < -0.01 ? ["left"] : []), ...(top < -0.01 ? ["top"] : []),
    ...(right > innerWidth + 0.01 ? ["right"] : []), ...(bottom > innerHeight + 0.01 ? ["bottom"] : []),
  ];
  const holder = field ? document.querySelector(field) : null;
  // A popup intentionally covers the conversation. Compare neighbours within the same UI layer,
  // while the point probes above still catch anything that actually steals this control's clicks.
  const layer = (node: Element): Element | null => node.closest('.reply-options, [role="dialog"], [role="menu"]');
  const overlaps: string[] = [];
  for (const other of document.querySelectorAll(selector)) {
    if (other === holder || owns(other) || other.contains(element)) continue;
    if (layer(other) !== layer(element)) continue;
    const box = other.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
    if (!hit || !(hit === other || other.contains(hit))) continue;
    const across = Math.min(right, box.right) - Math.max(left, box.left);
    const down = Math.min(bottom, box.bottom) - Math.max(top, box.top);
    if (across > 0.5 && down > 0.5) overlaps.push(describe(other));
  }
  let overText = 0;
  if (holder) {
    const box = holder.getBoundingClientRect();
    const own = getComputedStyle(holder);
    const textLeft = box.left + Number.parseFloat(own.borderLeftWidth) + Number.parseFloat(own.paddingLeft);
    const textRight = box.right - Number.parseFloat(own.borderRightWidth) - Number.parseFloat(own.paddingRight);
    overText = Math.max(0, Math.min(right, textRight) - Math.max(left, textLeft));
  }
  return { width: rect.width, height: rect.height, outside, missed, overlaps, overText };
}

/** The control (scrolled into view) is a hit area of `size` px or more, on the screen, whole and apart. */
async function expectTarget(name: string, control: Locator, size = 44, field: string | null = null): Promise<void> {
  await control.scrollIntoViewIfNeeded();
  const found = await control.evaluate(inspect, { selector: CONTROLS, field });
  expect.soft(found.width, `${name}: width`).toBeGreaterThanOrEqual(size - 0.01);
  expect.soft(found.height, `${name}: height`).toBeGreaterThanOrEqual(size - 0.01);
  expect.soft(found.outside, `${name}: edges past the viewport`).toEqual([]);
  expect.soft(found.missed, `${name}: points of its box another element takes`).toEqual([]);
  expect.soft(found.overlaps, `${name}: controls it overlaps`).toEqual([]);
  expect.soft(found.overText, `${name}: px over its field's text`).toBe(0);
}

type Corner = "top left" | "top right" | "bottom left" | "bottom right";

/** A click, or a tap on a touch screen, 5 px from a corner of the control's box. */
async function press(control: Locator, corner: Corner, touch: boolean): Promise<void> {
  await control.scrollIntoViewIfNeeded();
  const box = await control.boundingBox();
  expect(box, "the control is rendered").not.toBeNull();
  const position = { x: corner.endsWith("left") ? 5 : box!.width - 5, y: corner.startsWith("top") ? 5 : box!.height - 5 };
  if (touch) await control.tap({ position });
  else await control.click({ position });
}

/** The pointer and the focus leave the controls: no tooltip covers a neighbour while boxes are measured. */
async function calm(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(page.locator(".tooltip")).toHaveCount(0);
}

/**
 * Signs in as the installation administrator, so the app bar shows all its controls; a folder with a one-letter
 * name gives the folder tabs their narrowest tab.
 */
async function start(page: Page, context: BrowserContext, request: APIRequestContext): Promise<boolean> {
  await scenario(request, { me: "session", data: { account: "admin" } });
  await context.addCookies([SESSION_COOKIE]);
  const folder = await page.request.post("/console/projects/p1/folders", { data: { name: "Я" } });
  expect(folder.ok(), await folder.text()).toBe(true);
  // Without motion no window is measured half-way through its entrance.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/console/");
  await expect(page.locator("#workspace")).toBeVisible();
  return page.evaluate(() => matchMedia("(pointer: coarse)").matches);
}

const lines = (count: number) => Array.from({ length: count }, (_, line) => `Пункт ${line + 1}`).join("\n");

for (const screen of SCREENS) {
  test.describe(`hit areas, ${screen.name}`, () => {
    const touch = "hasTouch" in screen;
    const narrow = screen.viewport.width <= 700;
    test.use({ viewport: screen.viewport, hasTouch: touch, deviceScaleFactor: "deviceScaleFactor" in screen ? screen.deviceScaleFactor : 1 });
    test.beforeEach(async ({ page }) => {
      if ("font" in screen) await page.addInitScript(font => {
        document.addEventListener("DOMContentLoaded", () => document.documentElement.style.setProperty("--font-sans", `"${font}", sans-serif`));
      }, screen.font);
    });

    test("app bar, list column, dialogue, reply box, attachment, quick replies, customer card and image viewer", async ({ page, context, request, consoleErrors }) => {
      void consoleErrors;
      const coarse = await start(page, context, request);
      // Touch is emulated with a coarse primary pointer in every engine; a mouse keeps a fine one.
      expect(coarse).toBe(touch);
      const project = page.getByRole("button", { name: /^Текущий проект/ });
      await calm(page);
      await expectTarget("project menu", project);
      await expectTarget("administration menu", page.getByRole("button", { name: "Управление", exact: true }));
      await expectTarget("quick replies catalog", page.getByRole("button", { name: "Управление готовыми ответами" }));
      await expectTarget("archive", page.getByRole("button", { name: "Открыть архив" }));
      await expectTarget("folder tab with a one-letter name", page.getByRole("tab", { name: "Я", exact: true }));
      await expectTarget("folders", page.getByRole("button", { name: "Управление общими папками" }));
      // The caption "Текущий проект" is part of the project's button.
      await press(project, "top left", touch);
      await expect(page.getByRole("menu")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toBeHidden();

      await page.getByRole("listbox", { name: "Диалоги" }).getByRole("option", { name: /Анна Смирнова/ }).click();
      await expect(page.getByRole("textbox", { name: "Текст ответа" })).toBeEditable();
      await calm(page);
      await expectTarget("project menu in a dialogue", project);
      if (narrow) await expectTarget("back to the list", page.getByRole("button", { name: "К списку диалогов" }), coarse ? 48 : 44);
      const customer = page.locator("#customer-open");
      await expectTarget("customer card", customer);
      const folder = page.getByRole("button", { name: /^Папка диалога/ });
      await expectTarget("dialogue folder", folder);
      const attach = page.getByRole("button", { name: "Прикрепить файл" });
      const replies = page.locator(".composer").getByRole("button", { name: "Готовые ответы" });
      await expectTarget("attach a file", attach);
      await expectTarget("quick replies", replies);
      await expectTarget("send", page.getByRole("button", { name: "Отправить" }));
      // The reply box keeps its height. On a narrow screen, where all three buttons are icons, its text field keeps
      // the room it had beside 40 px buttons: 2 px of border, 5 px of padding on each side, three 8 px gaps.
      const box = await page.locator(".composer").evaluate((form) => ({
        width: form.getBoundingClientRect().width,
        height: form.getBoundingClientRect().height,
        text: form.querySelector("textarea")!.getBoundingClientRect().width,
      }));
      expect.soft(box.height, "reply box height").toBeLessThanOrEqual(52.01);
      if (narrow) expect.soft(box.text, "room for the text").toBeGreaterThanOrEqual(box.width - 2 - 10 - 3 * 40 - 3 * 8 - 0.01);
      await press(folder, "bottom right", touch);
      await expect(page.getByRole("menu")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toBeHidden();

      const chooser = page.waitForEvent("filechooser");
      await press(attach, "top right", touch);
      await (await chooser).setFiles({ name: "photo.png", mimeType: "image/png", buffer: Buffer.from("89504e47", "hex") });
      const preview = page.getByRole("group", { name: "Выбранные вложения" });
      await expect(preview).toBeVisible();
      const remove = page.getByRole("button", { name: "Убрать вложение" });
      await calm(page);
      await expectTarget("remove the attachment", remove);
      await press(remove, "bottom left", touch);
      await expect(preview).toBeHidden();

      await press(replies, "bottom left", touch);
      const groups = page.getByRole("listbox", { name: "Группы ответов" });
      await expect(groups.getByRole("option")).toHaveCount(2);
      const close = page.getByRole("button", { name: "Закрыть готовые ответы" });
      await calm(page);
      await expectTarget("close the quick replies", close);
      await groups.getByRole("option").first().click();
      await expect(page.getByRole("listbox", { name: "Готовые ответы" })).toBeVisible();
      await calm(page);
      await expectTarget("back to the groups", page.getByRole("button", { name: "← Группы" }));
      await expectTarget("close the quick replies in a group", close);
      await press(close, "top right", touch);
      await expect(page.locator(".reply-options")).toBeHidden();

      await press(customer, "bottom right", touch);
      const card = page.getByRole("button", { name: "Закрыть карточку" });
      await expect(card).toBeVisible();
      await calm(page);
      await expectTarget("close the customer card", card);
      await press(card, "top right", touch);
      await expect(card).toBeHidden();

      await page.getByRole("region", { name: "Переписка" }).getByRole("button", { name: "Открыть изображение" }).click();
      const viewer = page.getByRole("dialog", { name: "Просмотр изображения" });
      await expect(viewer).toBeVisible();
      await calm(page);
      // Viewing a photo on a touch screen: the toolbar has room for 48 px buttons.
      const tool = coarse ? 48 : 44;
      await expectTarget("zoom out", viewer.getByRole("button", { name: "Уменьшить" }), tool);
      await expectTarget("fit the window", viewer.getByRole("button", { name: /%$/ }), tool);
      await expectTarget("zoom in", viewer.getByRole("button", { name: "Увеличить" }), tool);
      const shut = viewer.getByRole("button", { name: "Закрыть изображение" });
      await expectTarget("close the image", shut, tool);
      await press(shut, "bottom left", touch);
      await expect(viewer).toBeHidden();
    });

    test("windows: projects, folders, a confirmation, the quick replies catalog with its panes", async ({ page, context, request, consoleErrors }) => {
      void consoleErrors;
      await start(page, context, request);
      await page.getByRole("button", { name: "Управление", exact: true }).click();
      await page.getByRole("menuitem", { name: "Проекты" }).click();
      const projects = page.getByRole("dialog", { name: "Проекты" });
      await expect(projects).toBeVisible();
      await calm(page);
      await expectTarget("close the projects", projects.getByRole("button", { name: "Закрыть", exact: true }));
      // A project's own screen has a title without a description above its way back.
      await projects.getByRole("button", { name: "Настроить проект Поддержка" }).click();
      const managed = page.getByRole("dialog", { name: "Поддержка" });
      await expect(managed.getByRole("button", { name: "Все проекты" })).toBeFocused();
      await calm(page);
      const managedClose = managed.getByRole("button", { name: "Закрыть", exact: true });
      await expectTarget("close a project's screen", managedClose);
      await press(managedClose, "top right", touch);
      await expect(managed).toBeHidden();

      await page.getByRole("button", { name: "Управление общими папками" }).click();
      const folders = page.getByRole("dialog", { name: "Общие папки" });
      await expect(folders).toBeVisible();
      await calm(page);
      const foldersClose = folders.getByRole("button", { name: "Закрыть папки" });
      await expectTarget("close the folders", foldersClose);
      await expectTarget("rename a folder", folders.getByRole("button", { name: "Переименовать папку VIP" }));
      const remove = folders.getByRole("button", { name: "Удалить папку VIP" });
      await expectTarget("delete a folder", remove);
      await press(remove, "bottom left", touch);
      const confirm = page.getByRole("dialog", { name: "Удалить папку?" });
      await expect(confirm).toBeVisible();
      await calm(page);
      const confirmClose = confirm.getByRole("button", { name: "Закрыть", exact: true });
      await expectTarget("close the confirmation", confirmClose);
      await press(confirmClose, "top right", touch);
      await expect(confirm).toBeHidden();
      await press(foldersClose, "bottom left", touch);
      await expect(folders).toBeHidden();

      // A reply longer than six lines has a toggle.
      const added = await page.request.post("/console/projects/p1/replies", { data: { group_id: "g1", text: lines(9) } });
      expect(added.ok(), await added.text()).toBe(true);
      await page.getByRole("button", { name: "Управление готовыми ответами" }).click();
      const catalog = page.getByRole("dialog", { name: "Готовые ответы" });
      const groupList = catalog.getByRole("listbox", { name: "Группы" });
      await expect(groupList.getByRole("option").first()).toBeVisible();
      // On a phone the catalog shows one level at a time: the group is opened from the list of groups.
      if (narrow) await groupList.getByRole("option", { name: "/общее" }).click();
      const general = catalog.getByRole("region", { name: "Группа /общее", exact: true });
      await expect(general.getByRole("article")).toHaveCount(3);
      await calm(page);
      const catalogClose = catalog.getByRole("button", { name: "Закрыть", exact: true });
      await expectTarget("close the catalog", catalogClose);
      if (narrow) await expectTarget("back to the groups", general.getByRole("button", { name: "К списку групп" }));
      await expectTarget("group actions", general.getByRole("button", { name: /^Действия с группой/ }));
      const long = general.getByRole("article", { name: /^Ответ: Пункт 1/ });
      const actions = long.getByRole("button", { name: /^Действия с ответом/ });
      await expectTarget("reply actions", actions);
      const show = long.getByRole("button", { name: "Показать ответ полностью" });
      await expectTarget("show the whole reply", show);
      await press(show, "bottom right", touch);
      const hide = long.getByRole("button", { name: "Свернуть ответ" });
      await calm(page);
      await expectTarget("collapse the reply", hide);
      await press(hide, "top left", touch);
      await expect(show).toBeVisible();

      await general.getByRole("button", { name: "Добавить ответ" }).click();
      const editorBack = catalog.getByRole("button", { name: "Назад к ответам группы" });
      await expect(editorBack).toBeVisible();
      await calm(page);
      await expectTarget("back from the editor", editorBack);
      await press(editorBack, "bottom left", touch);
      await expect(general.getByRole("button", { name: "Добавить ответ" })).toBeVisible();

      await press(actions, "top left", touch);
      await page.getByRole("menuitem", { name: "Перенести" }).click();
      const moveBack = catalog.getByRole("button", { name: "Назад к /общее" });
      await expect(moveBack).toBeVisible();
      await calm(page);
      await expectTarget("back from moving", moveBack);
      await press(moveBack, "top right", touch);
      await expect(general.getByRole("article")).toHaveCount(3);

      const search = catalog.getByRole("searchbox", { name: "Поиск в каталоге" });
      await search.fill("Пункт");
      const clear = catalog.getByRole("button", { name: "Очистить поиск" });
      await expect(clear).toBeVisible();
      await calm(page);
      // Inside the search field: over its padding, never over the text.
      await expectTarget("clear the search", clear, 44, 'input[aria-label="Поиск в каталоге"]');
      await press(clear, "top left", touch);
      await expect(search).toHaveValue("");
      await press(catalogClose, "top right", touch);
      await expect(catalog).toBeHidden();
    });
  });
}
