import type { Page } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, test } from "./fixtures";

// Release sweep of the layout at every breakpoint the console has (1280, 1100 and 701 around the compact and narrow
// limits, 700 and below for phones), in the light and the dark theme: nothing wider than the screen, no control cut
// off by its edge, the header, the history and the reply box never overlap, the header keeps its height while the
// dialogue's folder loads and never says «Без папки» before it knows, the history ends at its last message, the
// reply box keeps its height under the pop-ups, and the pop-ups and the customer card stay on the screen. Real
// layout; every test also fails on a CSP violation or a console error.
const WIDTHS = [1280, 1100, 900, 701, 700, 430, 375, 320];
const input = (page: Page) => page.getByRole("textbox", { name: "Текст ответа" });
const header = (page: Page) => page.locator("#customer-open").locator("xpath=ancestor::header[1]");

/** Visible controls whose box leaves the screen sideways, except inside a box that scrolls them sideways. */
function offscreen(page: Page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const scrolls = (element: Element) => {
      for (let node = element.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && node.scrollWidth > node.clientWidth) return true;
      }
      return false;
    };
    return [...document.querySelectorAll<HTMLElement>("button, input, textarea, select, a[href], [role='option'], [role='tab'], [role='menuitem'], [role='menuitemradio']")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        if (!box.width || !box.height || getComputedStyle(element).visibility === "hidden" || element.closest("[aria-hidden='true'], [inert]")) return false;
        return (box.left < -0.5 || box.right > width + 0.5) && !scrolls(element);
      })
      .map((element) => `${element.tagName.toLowerCase()} «${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)}» ${Math.round(element.getBoundingClientRect().left)}–${Math.round(element.getBoundingClientRect().right)}`);
  });
}

async function fits(page: Page, width: number): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  expect(await offscreen(page)).toEqual([]);
}

/** The box of the first visible element matching the selector. */
function box(page: Page, selector: string) {
  return page.evaluate((selector) => {
    const element = [...document.querySelectorAll(selector)].find((item) => item.getBoundingClientRect().height > 0);
    if (!element) return null;
    const { top, bottom, left, right, height } = element.getBoundingClientRect();
    return { top, bottom, left, right, height };
  }, selector);
}

for (const width of WIDTHS) {
  test(`at ${width}px, light and dark: no overflow or overlap, a steady header, reply box and history`, async ({ page, context, request, consoleErrors, attachScreenshot }) => {
    void consoleErrors;
    test.slow();
    await page.setViewportSize({ width, height: 740 });
    await scenario(request, { me: "session" });
    await context.addCookies([SESSION_COOKIE]);
    await page.route("**/console/projects/*/commands", (route) => route.fulfill({ json: [
      { name: "info", description: "Информация о клиенте", arguments: "", mutation: false },
      { name: "gift", description: "Продлить подписку", arguments: "<дни>", mutation: true },
    ] }));
    // Boris's detail (with his folder, VIP) waits until it is let go.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/console/projects/p1/tickets/t2", async (route) => {
      await held;
      await route.continue();
    });
    await page.goto("/console/");
    const list = page.getByRole("listbox", { name: "Диалоги" });
    await expect(list.getByRole("option").first()).toBeVisible();
    await fits(page, width);

    await list.getByRole("option", { name: /Борис Петров/ }).click();
    await expect(header(page)).toBeVisible();
    await expect(header(page).locator(".folder-select-skeleton, .folder-icon-skeleton")).toBeVisible();
    const loading = (await box(page, "header:has(#customer-open)"))!;
    await expect(header(page)).not.toContainText("Без папки");
    release();
    await expect(header(page).getByRole("button", { name: "Папка диалога: VIP" })).toBeVisible();
    await expect(input(page)).toBeEditable();
    expect((await box(page, "header:has(#customer-open)"))!.height).toBe(loading.height);

    // Header, history and reply box one under the other, the history at its end.
    const [top, history, composer] = [(await box(page, "header:has(#customer-open)"))!, (await box(page, ".messages"))!, (await box(page, ".composer"))!];
    expect(top.bottom).toBeLessThanOrEqual(history.top + 0.5);
    expect(history.bottom).toBeLessThanOrEqual(composer.top + 0.5);
    expect(composer.bottom).toBeLessThanOrEqual(740);
    await expect.poll(() => page.locator(".messages").evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(2);
    await fits(page, width);

    // The pop-ups cover the history, never move the reply box, and stay on the screen.
    for (const [key, selector] of [["/", ".command-options"], ["#", ".reply-options:not(.command-options)"]] as const) {
      await input(page).fill("");
      await input(page).pressSequentially(key);
      await expect(page.locator(selector)).toBeVisible();
      const popup = (await box(page, selector))!;
      expect((await box(page, ".composer"))!.height).toBe(composer.height);
      expect((await box(page, ".composer"))!.top).toBe(composer.top);
      expect(popup.left).toBeGreaterThanOrEqual(0);
      expect(popup.right).toBeLessThanOrEqual(width);
      expect(popup.top).toBeGreaterThanOrEqual(0);
      await fits(page, width);
      await page.keyboard.press("Escape");
      await expect(page.locator(selector)).toHaveCount(0);
    }
    await input(page).fill("");

    // The customer card: on the screen, nothing wider than it.
    const card = page.locator("#customer-card");
    if (!(await card.isVisible())) await page.locator("#customer-open").click();
    await expect(card).toBeVisible();
    const seen = (await box(page, "#customer-card"))!;
    expect(seen.left).toBeGreaterThanOrEqual(0);
    expect(seen.right).toBeLessThanOrEqual(width);
    expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await fits(page, width);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await attachScreenshot(`layout-${width}-${theme}`);
      await fits(page, width);
    }
  });
}

// Forced colors and more contrast at a desktop and a phone width: the same layout, and every surface over the
// conversation keeps an edge of its own. Where the engine cannot emulate the mode, the test notes it and checks the
// layout only.
for (const [mode, media] of [["forced colors", { forcedColors: "active" }], ["more contrast", { contrast: "more" }]] as const) {
  for (const width of [1280, 375]) {
    test(`${mode} at ${width}px: no overflow, the pop-ups and the folder menu keep their edges`, async ({ page, context, request, consoleErrors }, testInfo) => {
      void consoleErrors;
      await page.emulateMedia(media);
      await page.setViewportSize({ width, height: 740 });
      await scenario(request, { me: "session" });
      await context.addCookies([SESSION_COOKIE]);
      await page.goto("/console/");
      const query = mode === "forced colors" ? "(forced-colors: active)" : "(prefers-contrast: more)";
      const applied = await page.evaluate((query) => matchMedia(query).matches, query);
      if (!applied) testInfo.annotations.push({ type: "not emulated", description: `${query} is not emulated in this engine` });
      await page.getByRole("listbox", { name: "Диалоги" }).getByRole("option", { name: /Борис Петров/ }).click();
      await expect(input(page)).toBeEditable();
      await fits(page, width);
      const edge = (selector: string) => page.locator(selector).first().evaluate((element) => {
        const style = getComputedStyle(element);
        return `${style.borderTopWidth} ${style.borderTopStyle}`;
      });
      await input(page).pressSequentially("#");
      await expect(page.locator(".reply-options")).toBeVisible();
      if (applied) expect(await edge(".reply-options")).toBe("1px solid");
      await fits(page, width);
      await page.keyboard.press("Escape");
      await header(page).getByRole("button", { name: /^Папка диалога: / }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      if (applied) expect(await edge(".menu")).toBe("1px solid");
      await fits(page, width);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
    });
  }
}
