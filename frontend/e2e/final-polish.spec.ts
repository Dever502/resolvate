import type { APIRequestContext, BrowserContext, Locator, Page } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, test } from "./fixtures";

// The last visual details (styles/app.css, composer/QuickReplies.vue, workspace/MobileMenu.vue): the corners of the
// items in menus and pop-ups follow their surface's, the pop-ups over the reply box have an edge in both themes,
// the quick replies close with the same icon as every other close button, the unread count has even digits, short
// UI text wraps without a lone last word while messages keep the browser's wrapping, and the phone drawer slides
// out as it closes. Every test also fails on a CSP violation or a console error.
const input = (page: Page) => page.getByRole("textbox", { name: "Текст ответа" });
const menuButton = (page: Page) => page.getByRole("button", { name: /^Меню\. Проект:/ });
const drawer = (page: Page) => page.getByRole("dialog", { name: "Resolvate" });

async function start(page: Page, context: BrowserContext, request: APIRequestContext, width: number, data: object = {}): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await scenario(request, { me: "session", data });
  await context.addCookies([SESSION_COOKIE]);
  await page.goto("/console/");
  await expect(page.getByRole("listbox", { name: "Диалоги" }).getByRole("option").first()).toBeVisible();
}

async function openDialogue(page: Page): Promise<void> {
  await page.getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(input(page)).toBeEditable();
}

/** The radius of the first visible `outer` and of its first `inner`, and how far the inner sits from its outer edge. */
function nesting(page: Page, outer: string, inner: string) {
  return page.evaluate(({ outer, inner }) => {
    const surface = [...document.querySelectorAll<HTMLElement>(outer)].find((element) => element.getBoundingClientRect().width > 0)!;
    const item = surface.querySelector<HTMLElement>(inner)!;
    return {
      outer: parseFloat(getComputedStyle(surface).borderTopLeftRadius),
      inner: parseFloat(getComputedStyle(item).borderTopLeftRadius),
      inset: item.getBoundingClientRect().left - surface.getBoundingClientRect().left,
    };
  }, { outer, inner });
}

function expectConcentric({ outer, inner, inset }: { outer: number; inner: number; inset: number }): void {
  expect(inner).toBeGreaterThan(0);
  expect(Math.abs(inner - (outer - inset))).toBeLessThanOrEqual(0.5);
}

/** The edge of a visible pop-up against the theme's --border, and against its own background. */
function edge(page: Page, selector: string) {
  return page.evaluate((selector) => {
    const surface = [...document.querySelectorAll<HTMLElement>(selector)].find((element) => element.getBoundingClientRect().width > 0)!;
    const probe = document.createElement("div");
    probe.style.borderTop = "1px solid var(--border)";
    document.body.append(probe);
    const border = getComputedStyle(probe).borderTopColor;
    probe.remove();
    const style = getComputedStyle(surface);
    return { width: style.borderTopWidth, style: style.borderTopStyle, color: style.borderTopColor, border, background: style.backgroundColor };
  }, selector);
}

test("menu and pop-up items nest in their surface's corner", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await page.route("**/console/projects/*/commands", (route) => route.fulfill({ json: [
    { name: "info", description: "Информация о клиенте", arguments: "", mutation: false },
  ] }));
  await start(page, context, request, 1280);
  await openDialogue(page);
  await input(page).pressSequentially("#");
  await expect(page.locator(".reply-options .reply-option").first()).toBeVisible();
  expectConcentric(await nesting(page, ".reply-options", ".reply-option"));
  await page.keyboard.press("Escape");
  await input(page).fill("/");
  await expect(page.locator(".command-options .reply-option").first()).toBeVisible();
  expectConcentric(await nesting(page, ".command-options", ".reply-option"));
  await input(page).fill("");
  await page.getByRole("button", { name: /^Папка диалога/ }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  expectConcentric(await nesting(page, ".menu", ".menu-item"));
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Меню аккаунта:/ }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  expectConcentric(await nesting(page, ".menu", ".menu-item"));
  expectConcentric(await nesting(page, ".account-theme-options", ".account-theme-option"));
  await page.keyboard.press("Escape");
  // The catalog's scope switch, the same segmented control.
  await page.getByRole("button", { name: "Управление готовыми ответами", exact: true }).click();
  const catalog = page.getByRole("dialog", { name: "Готовые ответы" });
  await expect(catalog).toBeVisible();
  if (!(await catalog.locator(".catalog-scope").isVisible())) await catalog.getByRole("listbox", { name: "Группы" }).getByRole("option").first().click();
  await expect(catalog.locator(".catalog-scope")).toBeVisible();
  expectConcentric(await nesting(page, ".catalog-scope", "button"));
});

test("the pop-ups over the reply box have the theme's edge in light and dark, and do not move the reply box", async ({ page, context, request, consoleErrors, browserName, attachScreenshot }) => {
  void consoleErrors;
  await start(page, context, request, 1280);
  await openDialogue(page);
  const composer = page.locator(".composer");
  const before = await composer.boundingBox();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await input(page).pressSequentially("#");
    await expect(page.locator(".reply-options .reply-option").first()).toBeVisible();
    const seen = await edge(page, ".reply-options");
    expect(seen).toMatchObject({ width: "1px", style: "solid", color: seen.border });
    expect(seen.color).not.toBe(seen.background);
    expect(await composer.boundingBox()).toEqual(before);
    await attachScreenshot(`quick-replies-${theme}`);
    await page.keyboard.press("Escape");
    await input(page).fill("");
  }
  if (browserName !== "chromium") return;
  // High contrast keeps its own edge.
  await page.emulateMedia({ forcedColors: "active" });
  await input(page).pressSequentially("#");
  await expect(page.locator(".reply-options .reply-option").first()).toBeVisible();
  expect(await edge(page, ".reply-options")).toMatchObject({ width: "1px", style: "solid" });
});

test("the quick replies close with the close icon: named, 44×44, the reply box gets the focus back", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await start(page, context, request, 1280);
  await openDialogue(page);
  await input(page).pressSequentially("#");
  const close = page.locator(".reply-options").getByRole("button", { name: "Закрыть готовые ответы" });
  // The groups are in: the list grows up as they come, moving its head and the button with it.
  const loaded = page.locator(".reply-options .reply-option").first();
  await expect(loaded).toBeVisible();
  await expect(close).toHaveText("");
  await expect(close.locator(":scope > svg")).toHaveCount(1);
  const box = (await close.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await close.click();
  await expect(page.locator(".reply-options")).toHaveCount(0);
  await expect(input(page)).toBeFocused();
  // Esc still closes it.
  await input(page).pressSequentially("#");
  await expect(loaded).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".reply-options")).toHaveCount(0);
  await expect(input(page)).toBeFocused();
});

test("the unread count has even digits and fits every value", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await start(page, context, request, 1280);
  const seen = await page.evaluate(() => {
    const badge = document.querySelector<HTMLElement>(".count")!;
    const original = badge.textContent;
    const widths: Record<string, number> = {};
    let fits = true;
    for (const value of ["1", "8", "10", "11", "99", "99+"]) {
      badge.textContent = value;
      widths[value] = badge.getBoundingClientRect().width;
      fits &&= badge.scrollWidth <= badge.clientWidth;
    }
    badge.textContent = original;
    return { numeric: getComputedStyle(badge).fontVariantNumeric, widths, fits };
  });
  expect(seen.numeric).toBe("tabular-nums");
  expect(seen.fits).toBe(true);
  expect(seen.widths["1"]).toBe(seen.widths["8"]);
  expect(seen.widths["10"]).toBe(seen.widths["11"]);
  expect(seen.widths["11"]).toBe(seen.widths["99"]);
  expect(seen.widths["99+"]).toBeGreaterThan(seen.widths["99"]!);
});

test("titles and short UI text wrap evenly; messages keep the browser's wrapping", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await start(page, context, request, 375, { account: "admin" });
  const wrap = (target: string | Locator) => (typeof target === "string" ? page.locator(target) : target).first().evaluate((element) => getComputedStyle(element).getPropertyValue("text-wrap-style") || getComputedStyle(element).getPropertyValue("text-wrap"));
  const pretty = await page.evaluate(() => CSS.supports("text-wrap", "pretty"));
  const balance = await page.evaluate(() => CSS.supports("text-wrap", "balance"));
  await menuButton(page).click();
  await drawer(page).getByRole("button", { name: "Проекты" }).click();
  await expect(page.getByRole("dialog", { name: "Проекты" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Управление общими папками" }).click();
  await page.getByRole("dialog", { name: "Общие папки" }).getByRole("button", { name: "Удалить папку VIP" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Удалить папку?" }).or(page.getByRole("dialog", { name: "Удалить папку?" }));
  await expect(confirm).toBeVisible();
  if (balance) expect(await wrap(confirm.locator("h2"))).toContain("balance");
  if (pretty) expect(await wrap(confirm.locator("p"))).toContain("pretty");
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await page.keyboard.press("Escape");
  await openDialogue(page);
  expect(await wrap(".bubble")).not.toMatch(/balance|pretty/);
});

interface Closing { closedAt: number; removedAt: number; animations: { name: string; state: string }[]; name: string; xs: number[] }

/** Watches the open drawer close: when it turns closed, its animations then, its x every frame, when it leaves. */
async function watchClosing(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    const find = () => {
      const element = document.querySelector<HTMLElement>(".drawer");
      if (!element) return requestAnimationFrame(find);
      const log: Closing = { closedAt: 0, removedAt: 0, animations: [], name: "", xs: [] };
      (window as unknown as { closing: Closing }).closing = log;
      const sample = () => {
        if (!element.isConnected) return;
        log.xs.push(element.getBoundingClientRect().x);
        requestAnimationFrame(sample);
      };
      new MutationObserver((_, observer) => {
        if (!log.closedAt && element.dataset.state === "closed") {
          log.closedAt = performance.now();
          log.animations = element.getAnimations().map((animation) => ({ name: (animation as CSSAnimation).animationName, state: animation.playState }));
          log.name = getComputedStyle(element).animationName;
          sample();
        }
        if (log.closedAt && !element.isConnected) {
          log.removedAt = performance.now();
          observer.disconnect();
        }
      }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] });
      resolve();
    };
    find();
  }));
}

async function closed(page: Page): Promise<Closing> {
  await expect(page.locator(".drawer")).toHaveCount(0);
  await expect(page.locator(".dialog-backdrop")).toHaveCount(0);
  await expect(menuButton(page)).toBeFocused();
  expect(await page.evaluate(() => getComputedStyle(document.body).pointerEvents)).not.toBe("none");
  return page.evaluate(() => (window as unknown as { closing: Closing }).closing);
}

function expectSlidOut(log: Closing): void {
  expect(log.animations.map(({ name }) => name)).toContain("drawer-out");
  expect(log.removedAt - log.closedAt).toBeGreaterThanOrEqual(100);
  // Only ever to the left, never back in first.
  for (let index = 1; index < log.xs.length; index++) expect(log.xs[index]).toBeLessThanOrEqual(log.xs[index - 1]! + 0.5);
}

async function opened(page: Page): Promise<void> {
  await menuButton(page).click();
  await expect(drawer(page)).toBeVisible();
  await drawer(page).evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
}

test("the drawer slides out on Esc, its close button and the backdrop, and gives the focus back", async ({ page, context, request, consoleErrors, browserName }, testInfo) => {
  void consoleErrors;
  await start(page, context, request, 375);
  const ways: [string, () => Promise<void>][] = [
    ["Esc", () => page.keyboard.press("Escape")],
    ["button", () => drawer(page).getByRole("button", { name: "Закрыть меню" }).click()],
    ["backdrop", () => page.locator(".drawer-backdrop").click({ position: { x: 360, y: 400 } })],
  ];
  for (const [way, close] of ways) {
    await opened(page);
    await watchClosing(page);
    await close();
    const log = await closed(page);
    expectSlidOut(log);
    if (way === "Esc" && browserName === "chromium") testInfo.annotations.push({ type: "drawer-closing", description: JSON.stringify(log) });
  }
});

test("closed while it still opens, the drawer leaves from where it is; quick reopening leaves nothing behind", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await start(page, context, request, 375);
  for (let cycle = 0; cycle < 4; cycle++) {
    await menuButton(page).click();
    await watchClosing(page);
    // Esc from the page a frame after it appeared, while the 150 ms opening still runs.
    const opening = await page.evaluate(() => new Promise<boolean>((resolve) => requestAnimationFrame(() => {
      const element = document.querySelector<HTMLElement>(".drawer")!;
      const running = element.getAnimations().some((animation) => animation.playState === "running");
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      resolve(running);
    })));
    const log = await closed(page);
    expectSlidOut(log);
    if (opening) expect(log.animations).toContainEqual({ name: "drawer-in", state: "paused" });
  }
  await opened(page);
  await expect(page.locator(".drawer")).toHaveCount(1);
  await expect(page.locator(".dialog-backdrop")).toHaveCount(1);
});

test("with reduced motion the drawer closes at once", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await start(page, context, request, 375);
  await opened(page);
  await watchClosing(page);
  await page.keyboard.press("Escape");
  const log = await closed(page);
  expect(log.name).toBe("none");
  expect(log.removedAt - log.closedAt).toBeLessThan(100);
});
