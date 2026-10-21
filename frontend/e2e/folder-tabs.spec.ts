import type { APIRequestContext, BrowserContext, Locator, Page } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, test } from "./fixtures";

// The folder tabs above the dialogue list (components/folders/FolderTabs.vue): one row that scrolls
// sideways by wheel, trackpad, touch and keyboard, with no visible scrollbar; an edge with tabs beyond
// it fades out (18 px). States are read from the row itself: scrollLeft, scrollWidth, clientWidth.
// Every test also fails on a CSP violation or a console error.
const FADE = 18;
const LONG = ["Срочные обращения", "Возвраты и претензии", "Партнёры и агенты", "Технические вопросы", "Оплата картой", "Корпоративные клиенты"];
const tabs = (page: Page) => page.getByRole("tablist", { name: "Папки диалогов" });
const tab = (page: Page, name: string) => tabs(page).getByRole("tab", { name, exact: true });
const manage = (page: Page) => page.getByRole("button", { name: "Управление общими папками" });
const resizer = (page: Page) => page.getByRole("separator", { name: "Ширина списка диалогов" });

interface Row { left: number; max: number; width: number; scrollbar: number; scrollbarWidth: string; overflow: string; start: boolean; end: boolean; fadeStart: string; fadeEnd: string; mask: string }
/** The row as the browser has it: where it is scrolled, its fades and the room a scrollbar takes. */
function row(page: Page): Promise<Row> {
  return tabs(page).evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      left: element.scrollLeft, max: element.scrollWidth - element.clientWidth, width: element.clientWidth,
      scrollbar: (element as HTMLElement).offsetHeight - element.clientHeight,
      scrollbarWidth: style.scrollbarWidth, overflow: style.overflowX,
      start: element.hasAttribute("data-beyond-start"), end: element.hasAttribute("data-beyond-end"),
      fadeStart: style.getPropertyValue("--folder-fade-start").trim(), fadeEnd: style.getPropertyValue("--folder-fade-end").trim(),
      mask: style.maskImage || style.getPropertyValue("-webkit-mask-image"),
    };
  });
}

/**
 * No scrollbar, still a scroller. Headless engines draw no scrollbars at all (Chromium runs with
 * --hide-scrollbars, Firefox and WebKit on Linux overlay theirs), so the room one takes proves little:
 * the computed scrollbar-width says the row asks for none, while overflow-x keeps it scrollable.
 */
function expectNoScrollbar(state: Row): void {
  expect(state.scrollbar).toBe(0);
  expect(state.scrollbarWidth).toBe("none");
  expect(state.overflow).toBe("auto");
}

/** The row's edges: which fades are on, once their 150 ms transition is over. */
async function expectEdges(page: Page, start: boolean, end: boolean): Promise<void> {
  await expect.poll(async () => {
    const { start: before, end: after, fadeStart, fadeEnd } = await row(page);
    return [before, after, fadeStart, fadeEnd];
  }).toEqual([start, end, start ? `${FADE}px` : "0px", end ? `${FADE}px` : "0px"]);
}

/** A tab all in view: inside the row, and clear of an edge that fades. */
async function fullyShown(page: Page, target: Locator): Promise<boolean> {
  const box = (await target.boundingBox())!;
  const view = (await tabs(page).boundingBox())!;
  const { start, end } = await row(page);
  return box.x >= view.x + (start ? FADE : 0) - 0.5 && box.x + box.width <= view.x + view.width - (end ? FADE : 0) + 0.5;
}

async function start(page: Page, context: BrowserContext, request: APIRequestContext, folders: string[] = LONG): Promise<void> {
  await scenario(request, { me: "session" });
  await context.addCookies([SESSION_COOKIE]);
  for (const name of folders) expect((await context.request.post("/console/projects/p1/folders", { data: { name } })).ok()).toBe(true);
  await page.goto("/console/");
  await expect(tab(page, "Все")).toHaveAttribute("aria-selected", "true");
}

test.describe("folder tabs", () => {
  test("tabs that all fit: no scrollbar, no fade", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request, []);
    const state = await row(page);
    expect(state.max).toBeLessThanOrEqual(1);
    expectNoScrollbar(state);
    await expectEdges(page, false, false);
  });

  test("more tabs than room: start, middle and end fade the edges with tabs beyond them; no scrollbar takes room", async ({ page, context, request, consoleErrors, attachScreenshot, browserName }, testInfo) => {
    void consoleErrors;
    await start(page, context, request);
    const state = await row(page);
    expect(state.max).toBeGreaterThan(100);
    expectNoScrollbar(state);
    expect(state.mask).toContain("linear-gradient");
    // B: at the start, only the end fades.
    expect(state.left).toBe(0);
    await expectEdges(page, false, true);
    await expect(tab(page, "Все")).toBeVisible();
    const shot = async (name: string) => {
      await attachScreenshot(name);
      if (browserName === "chromium") await page.locator("#ticket-sidebar").screenshot({ path: testInfo.outputPath(`${name}.png`) });
    };
    await shot("tabs-start");
    // C: in the middle, both edges.
    await tabs(page).evaluate((element) => { element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2; });
    await expectEdges(page, true, true);
    await shot("tabs-middle");
    // D: at the end, only the start.
    await tabs(page).evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    await expectEdges(page, true, false);
    expect((await row(page)).left).toBeGreaterThanOrEqual((await row(page)).max - 1);
    await shot("tabs-end");
    // Back at the start, the start's fade goes again.
    await tabs(page).evaluate((element) => { element.scrollLeft = 0; });
    await expectEdges(page, false, true);
  });

  test("a vertical wheel and a sideways trackpad scroll the row", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await tabs(page).hover();
    await page.mouse.wheel(0, 120);
    await expect.poll(async () => (await row(page)).left).toBeGreaterThan(0);
    const after = (await row(page)).left;
    await page.mouse.wheel(150, 0);
    await expect.poll(async () => (await row(page)).left).toBeGreaterThan(after);
    await expectEdges(page, true, true);
    await page.mouse.wheel(0, -5000);
    await expect.poll(async () => (await row(page)).left).toBe(0);
    await expectEdges(page, false, true);
  });

  test("the wheel works from all of the row's band, the tabs' text, edges and the space above them; not from the folders button or the list", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    const view = (await tabs(page).boundingBox())!;
    const search = (await page.getByRole("searchbox", { name: "Поиск клиента" }).boundingBox())!;
    const button = (await manage(page).boundingBox())!;
    const reset = () => tabs(page).evaluate((element) => { element.scrollLeft = 0; });
    // Every point an operator takes for the folder row, from under the search field to the row's line.
    const points: [string, number, number][] = [
      ["a tab's text", view.x + 30, view.y + view.height / 2],
      ["a tab's foot", view.x + 30, view.y + view.height - 2],
      ["the faded end", view.x + view.width - 6, view.y + view.height / 2],
      ["the space above the tabs", view.x + 60, (search.y + search.height + view.y) / 2],
      ["between the tabs and the button", (view.x + view.width + button.x) / 2, view.y + view.height / 2],
    ];
    for (const [where, x, y] of points) {
      await reset();
      await expectEdges(page, false, true);
      await page.mouse.move(x, y);
      await page.mouse.wheel(0, 120);
      await expect.poll(async () => (await row(page)).left, { message: where }).toBeGreaterThan(0);
      await expectEdges(page, true, true);
    }
    // To both ends with the wheel alone.
    await page.mouse.move(view.x + 60, view.y + view.height / 2);
    for (let step = 0; step < 30; step++) await page.mouse.wheel(0, 200);
    await expect.poll(async () => { const state = await row(page); return state.left >= state.max - 1; }).toBe(true);
    await expectEdges(page, true, false);
    for (let step = 0; step < 30; step++) await page.mouse.wheel(0, -200);
    await expect.poll(async () => (await row(page)).left).toBe(0);
    // At an end the wheel is not taken: the event goes on as the page's own.
    const taken = (deltaY: number) => page.evaluate(({ x, y, deltaY }) => {
      const target = document.elementFromPoint(x, y)!;
      const event = new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    }, { x: view.x + 60, y: view.y + view.height / 2, deltaY });
    expect(await taken(-120)).toBe(false);
    expect(await taken(120)).toBe(true);
    // Over the folders button and over the list the wheel moves no tab.
    for (const [x, y] of [[button.x + button.width / 2, button.y + button.height / 2], [view.x + 60, view.y + view.height + 60]] as const) {
      await reset();
      await page.mouse.move(x, y);
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(100);
      expect((await row(page)).left).toBe(0);
    }
  });

  test("the keyboard: every focused tab is all in view, clear of the fades; the chosen one keeps its mark", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    await tab(page, "Все").focus();
    await page.keyboard.press("End");
    await expect(tabs(page).getByRole("tab").last()).toBeFocused();
    await expect.poll(() => fullyShown(page, tabs(page).getByRole("tab").last())).toBe(true);
    await expectEdges(page, true, false);
    const count = await tabs(page).getByRole("tab").count();
    for (let index = count - 2; index >= 0; index--) {
      await page.keyboard.press("ArrowLeft");
      const focused = tabs(page).getByRole("tab").nth(index);
      await expect(focused).toBeFocused();
      await expect.poll(() => fullyShown(page, focused)).toBe(true);
    }
    await expectEdges(page, false, true);
    // A tab in the middle, chosen with Enter: selected, all in view, with its mark under it.
    for (let index = 0; index < 3; index++) await page.keyboard.press("ArrowRight");
    const chosen = tabs(page).getByRole("tab").nth(3);
    await page.keyboard.press("Enter");
    await expect(chosen).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => fullyShown(page, chosen)).toBe(true);
    const mark = await chosen.evaluate((element) => {
      const after = getComputedStyle(element, "::after");
      return { content: after.content, height: after.height };
    });
    expect(mark).toEqual({ content: '""', height: "3px" });
    // Home returns to the start: no fade there.
    await page.keyboard.press("Home");
    await expect(tab(page, "Все")).toBeFocused();
    await expect.poll(() => fullyShown(page, tab(page, "Все"))).toBe(true);
    await expectEdges(page, false, true);
  });

  test("a wider and a narrower sidebar: the fades follow the room, from overflow to all fitting and back", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    // End caps the sidebar at one third of the viewport. Leave room for all four
    // tabs (including the stub's VIP), padding and the management button even
    // when CI's font metrics differ. At 1600px they can still overflow by 4px.
    await page.setViewportSize({ width: 1920, height: 900 });
    await start(page, context, request, LONG.slice(0, 2));
    await resizer(page).focus();
    await page.keyboard.press("Home");
    await expect.poll(async () => (await row(page)).max).toBeGreaterThan(1);
    await expectEdges(page, false, true);
    await page.keyboard.press("End");
    await expect.poll(async () => (await row(page)).max).toBeLessThanOrEqual(1);
    await expectEdges(page, false, false);
    await page.keyboard.press("Home");
    await expectEdges(page, false, true);
    // The window narrower: the sidebar keeps its minimum, the row still scrolls.
    await page.setViewportSize({ width: 1100, height: 900 });
    await expectEdges(page, false, true);
  });

  test("a folder created, renamed and removed: the fades follow without a reload", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request, ["Срочные"]);
    await expectEdges(page, false, false);
    await manage(page).click();
    const dialog = page.getByRole("dialog", { name: "Общие папки" });
    for (const name of ["Возвраты и претензии", "Корпоративные клиенты"]) {
      await dialog.getByRole("textbox", { name: "Новая папка" }).fill(name);
      await dialog.getByRole("button", { name: "Создать" }).click();
      await expect(dialog.getByText(name, { exact: true })).toBeVisible();
    }
    await dialog.getByRole("button", { name: "Переименовать папку Срочные" }).click();
    await dialog.getByRole("textbox", { name: "Название папки" }).fill("Срочные обращения клиентов с оплатой");
    await dialog.getByRole("button", { name: "Сохранить" }).click();
    await expect(dialog.getByText("Срочные обращения клиентов с оплатой", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(tab(page, "Корпоративные клиенты")).toHaveCount(1);
    await expectEdges(page, false, true);
    // Back to one short folder: everything fits, no fade.
    await manage(page).click();
    for (const name of ["Возвраты и претензии", "Корпоративные клиенты"]) {
      await dialog.getByRole("button", { name: `Удалить папку ${name}` }).click();
      const confirm = page.getByRole("dialog", { name: "Удалить папку?" });
      await confirm.getByRole("button", { name: "Удалить папку" }).click();
      await expect(confirm).toBeHidden();
      await expect(dialog.getByText(name, { exact: true })).toHaveCount(0);
    }
    await dialog.getByRole("button", { name: "Переименовать папку Срочные обращения клиентов с оплатой" }).click();
    await dialog.getByRole("textbox", { name: "Название папки" }).fill("Срочные");
    await dialog.getByRole("button", { name: "Сохранить" }).click();
    await expect(dialog.getByText("Срочные", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tab(page, "Срочные")).toHaveCount(1);
    await expectEdges(page, false, false);
  });

  test("the folders button stays outside the row: never scrolled, never faded, 44×44, in place", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await start(page, context, request);
    const before = (await manage(page).boundingBox())!;
    expect(before.width).toBeGreaterThanOrEqual(44);
    expect(before.height).toBeGreaterThanOrEqual(44);
    expect(await manage(page).evaluate((element) => element.closest('[role="tablist"]') === null)).toBe(true);
    const view = (await tabs(page).boundingBox())!;
    expect(before.x).toBeGreaterThanOrEqual(view.x + view.width - 0.5);
    for (const element of [manage(page), manage(page).locator("..")]) {
      expect(await element.evaluate((node) => getComputedStyle(node).maskImage || getComputedStyle(node).getPropertyValue("-webkit-mask-image"))).toBe("none");
    }
    await tabs(page).evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    await expectEdges(page, true, false);
    expect(await manage(page).boundingBox()).toEqual(before);
    await manage(page).click();
    await expect(page.getByRole("dialog", { name: "Общие папки" })).toBeVisible();
  });

  for (const width of [375, 320]) {
    test(`on a ${width} px phone the row scrolls the same, the page does not`, async ({ page, context, request, consoleErrors }) => {
      void consoleErrors;
      await page.setViewportSize({ width, height: 812 });
      await start(page, context, request);
      const state = await row(page);
      expect(state.max).toBeGreaterThan(100);
      expectNoScrollbar(state);
      await expectEdges(page, false, true);
      await tabs(page).evaluate((element) => { element.scrollLeft = element.scrollWidth; });
      await expectEdges(page, true, false);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const button = (await manage(page).boundingBox())!;
      expect(button.x + button.width).toBeLessThanOrEqual(width);
    });
  }

  test.describe("in Chromium only", () => {
    // Skipped before the test's fixtures start: a page never opened has no CSP probe to check.
    test.skip(({ browserName }) => browserName !== "chromium", "Touch gestures (CDP) and forced colors are emulated in Chromium.");

    test("a mouse wheel through Chromium's own scroll input (gesture phases, latching) scrolls the row from its whole band", async ({ page, context, request, consoleErrors }) => {
      void consoleErrors;
      await start(page, context, request);
      const view = (await tabs(page).boundingBox())!;
      const search = (await page.getByRole("searchbox", { name: "Поиск клиента" }).boundingBox())!;
      const client = await context.newCDPSession(page);
      for (const y of [view.y + view.height / 2, (search.y + search.height + view.y) / 2]) {
        await tabs(page).evaluate((element) => { element.scrollLeft = 0; });
        await client.send("Input.synthesizeScrollGesture", {
          x: Math.round(view.x + 60), y: Math.round(y), xDistance: 0, yDistance: -240, gestureSourceType: "mouse", speed: 2000,
        });
        await expect.poll(async () => (await row(page)).left).toBeGreaterThan(100);
      }
    });

    test("a touch swipe scrolls the row", async ({ page, context, request, consoleErrors }) => {
      void consoleErrors;
      await page.setViewportSize({ width: 375, height: 812 });
      await start(page, context, request);
      const box = (await tabs(page).boundingBox())!;
      const client = await context.newCDPSession(page);
      await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      // A finger lands on the row and moves left: the browser scrolls it as for a phone's swipe.
      const y = Math.round(box.y + box.height / 2);
      const from = Math.round(box.x + box.width * 0.8);
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from, y }] });
      for (let step = 1; step <= 10; step++) {
        await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from - step * 20, y }] });
      }
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect.poll(async () => (await row(page)).left).toBeGreaterThan(50);
      await expectEdges(page, true, true);
    });

    test("forced colors: the tabs keep full contrast, no fade", async ({ page, context, request, consoleErrors }) => {
      void consoleErrors;
      await page.emulateMedia({ forcedColors: "active" });
      await start(page, context, request);
      await tabs(page).evaluate((element) => { element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2; });
      await expect.poll(async () => (await row(page)).start).toBe(true);
      expect((await row(page)).mask).toBe("none");
      expectNoScrollbar(await row(page));
    });
  });
});
