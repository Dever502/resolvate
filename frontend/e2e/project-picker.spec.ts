import type { APIRequestContext, BrowserContext, Locator, Page } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, test } from "./fixtures";

// The current project in the dark app bar (projects/ProjectPicker.vue, ui/MenuSelect.vue with tone "chrome") on
// the production build: the chevron follows the name at a fixed gap, the button keeps the full width of its column
// as the hit area, and the chevron turns while Reka marks the button open. The folder menu of a dialogue (tone
// "field") keeps its layout. Every test also fails on a CSP violation or a console error (fixtures.ts).
const CONSOLE = "/console/";
const SHORT = "TEST_1";
// Eighty characters: more than the app bar shows at any width.
const LONG = "Служба поддержки клиентов интернет-магазина бытовой техники и электроники Москвы";
const VIEWPORTS = [
  { device: "desktop", width: 1280, height: 800 },
  { device: "phone", width: 375, height: 812 },
] as const;

const project = (page: Page) => page.getByRole("button", { name: /^Текущий проект/ });
const menu = (page: Page) => page.getByRole("menu");

/** Signs in; the first available project (p1) is renamed to `name` in the stub's own answer. */
async function start(page: Page, context: BrowserContext, request: APIRequestContext, name: string): Promise<void> {
  await scenario(request, { me: "session" });
  await context.addCookies([SESSION_COOKIE]);
  await page.route("**/console/projects", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const projects = (await response.json()) as { id: string; name: string }[];
    return route.fulfill({ response, json: projects.map((item) => (item.id === "p1" ? { ...item, name } : item)) });
  });
  await page.goto(CONSOLE);
  await expect(page.locator("#workspace")).toBeVisible();
  // The button is named by the whole name, whatever it shows.
  await expect(project(page)).toHaveAccessibleName(`Текущий проект ${name}`);
}

interface Edges {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Client edges of a menu button: the button, its container, the value's box, the value's text (a range over the
 * characters, so the last letter rather than the box) and the chevron's box.
 */
function layout(trigger: Locator): Promise<Record<"button" | "container" | "value" | "text" | "chevron", Edges>> {
  return trigger.evaluate((button) => {
    const edges = ({ left, right, top, bottom }: DOMRect): Edges => ({ left, right, top, bottom });
    const value = button.querySelector("span")!;
    const text = document.createRange();
    text.selectNodeContents(value);
    return {
      button: edges(button.getBoundingClientRect()),
      container: edges(button.parentElement!.getBoundingClientRect()),
      value: edges(value.getBoundingClientRect()),
      text: edges(text.getBoundingClientRect()),
      chevron: edges(button.querySelector("svg")!.getBoundingClientRect()),
    };
  });
}

/** The chevron's turn in whole degrees, from its computed transform: 0 points down, 180 points up. */
function turn(trigger: Locator): Promise<number> {
  return trigger.locator("svg").evaluate((icon) => {
    const { transform } = getComputedStyle(icon);
    if (transform === "none") return 0;
    // matrix(a, b, …) or matrix3d(a, b, …): a and b are the cosine and the sine of the turn.
    const [a = 1, b = 0] = transform.slice(transform.indexOf("(") + 1).split(",").map(Number.parseFloat);
    return Math.round((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  });
}

for (const { device, width, height } of VIEWPORTS) {
  test.describe(`current project in the app bar, ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height });
    });

    test("a short name: the chevron follows it, the button keeps its container's width and its free end opens the menu", async ({ page, context, request, consoleErrors, attachScreenshot }) => {
      void consoleErrors;
      await start(page, context, request, SHORT);
      // Without motion a theme switch repaints at once, so no screenshot catches a colour halfway.
      await page.emulateMedia({ reducedMotion: "reduce" });
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        await attachScreenshot(`picker-short-${device}-${theme}.png`);
      }
      const trigger = project(page);
      const { button, container, text, chevron } = await layout(trigger);
      // From the last letter to the chevron's box, to a tenth of a pixel (subpixel layout).
      const gap = Math.round((chevron.left - text.right) * 10) / 10;
      expect(gap).toBeGreaterThanOrEqual(8);
      expect(gap).toBeLessThanOrEqual(12);
      // The name and the chevron start the button; the button still spans its container.
      expect(text.left).toBeCloseTo(button.left, 0);
      expect(button.left).toBeCloseTo(container.left, 1);
      expect(button.right).toBeCloseTo(container.right, 1);

      // Past the chevron the button itself takes the click and opens the menu.
      const point = { x: button.right - 4, y: (button.top + button.bottom) / 2 };
      expect(point.x).toBeGreaterThan(chevron.right + 24);
      expect(await trigger.evaluate((element, { x, y }) => document.elementFromPoint(x, y) === element, point)).toBe(true);
      await trigger.click({ position: { x: point.x - button.left, y: point.y - button.top } });
      await expect(menu(page)).toBeVisible();
      await expect(trigger).toHaveAttribute("data-state", "open");
      await page.keyboard.press("Escape");
      await expect(menu(page)).toBeHidden();
    });

    test("the chevron turns up while the menu is open and back after Esc, a click outside, a choice and the keyboard", async ({ page, context, request, consoleErrors }) => {
      void consoleErrors;
      await start(page, context, request, SHORT);
      const trigger = project(page);
      const icon = trigger.locator("svg");
      await expect(trigger).toHaveAttribute("data-state", "closed");
      expect(await turn(trigger)).toBe(0);
      // About 150 ms each way.
      await expect(icon).toHaveCSS("transition-property", "transform");
      await expect(icon).toHaveCSS("transition-duration", "0.15s");
      const opens = async (action: () => Promise<void>) => {
        await action();
        await expect(menu(page)).toBeVisible();
        await expect(trigger).toHaveAttribute("data-state", "open");
        await expect.poll(() => turn(trigger)).toBe(180);
      };
      const closes = async () => {
        await expect(menu(page)).toBeHidden();
        await expect(trigger).toHaveAttribute("data-state", "closed");
        await expect.poll(() => turn(trigger)).toBe(0);
      };

      await opens(() => trigger.click());
      await page.keyboard.press("Escape");
      await closes();
      await expect(trigger).toBeFocused();

      await opens(() => trigger.click());
      await page.getByRole("banner").getByText("Resolvate").click();
      await closes();

      await opens(() => trigger.click());
      await page.getByRole("menuitemradio", { name: "Второй проект" }).click();
      await closes();
      await expect(trigger).toHaveAccessibleName("Текущий проект Второй проект");

      // The keyboard: Enter or ArrowDown opens the menu at its first item, arrows move, Enter picks. The pointer
      // leaves the place of the menu, so no item is highlighted under it.
      await page.mouse.move(0, 0);
      await trigger.focus();
      await opens(() => page.keyboard.press("Enter"));
      await expect(page.getByRole("menuitemradio", { name: SHORT })).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("menuitemradio", { name: "Второй проект" })).toBeFocused();
      await page.keyboard.press("Escape");
      await closes();
      await expect(trigger).toBeFocused();
      await opens(() => page.keyboard.press("ArrowDown"));
      await expect(page.getByRole("menuitemradio", { name: SHORT })).toBeFocused();
      await page.keyboard.press("Enter");
      await closes();
      await expect(trigger).toBeFocused();
      await expect(trigger).toHaveAccessibleName(`Текущий проект ${SHORT}`);

      // Reduced motion: the global rule drops the transition, and the chevron turns at once.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(icon).toHaveCSS("transition-duration", "0s");
      await page.keyboard.press("Enter");
      await expect(trigger).toHaveAttribute("data-state", "open");
      expect(await turn(trigger)).toBe(180);
      await page.keyboard.press("Escape");
      await expect(trigger).toHaveAttribute("data-state", "closed");
      expect(await turn(trigger)).toBe(0);
    });

    test("a long name ends in an ellipsis; the chevron stays whole inside the button and nothing overflows", async ({ page, context, request, consoleErrors, attachScreenshot }) => {
      void consoleErrors;
      await start(page, context, request, LONG);
      const trigger = project(page);
      await expect(trigger).toHaveAccessibleName(`Текущий проект ${LONG}`);
      expect(await trigger.locator("span").evaluate((element) => ({
        clipped: element.scrollWidth > element.clientWidth,
        overflow: getComputedStyle(element).textOverflow,
      }))).toEqual({ clipped: true, overflow: "ellipsis" });
      const { button, container, value: name, chevron } = await layout(trigger);
      // The name takes the room the gap and the chevron leave: the chevron ends with the button, never past it.
      expect(button.left).toBeCloseTo(container.left, 1);
      expect(button.right).toBeCloseTo(container.right, 1);
      expect(chevron.left - name.right).toBeCloseTo(8, 0);
      expect(chevron.right - chevron.left).toBeCloseTo(16, 0);
      expect(chevron.right).toBeCloseTo(button.right, 0);
      expect(chevron.right).toBeLessThanOrEqual(button.right + 0.01);
      expect(chevron.left).toBeGreaterThanOrEqual(button.left);
      expect(chevron.top).toBeGreaterThanOrEqual(button.top);
      expect(chevron.bottom).toBeLessThanOrEqual(button.bottom);
      await expect(trigger.locator("svg")).toBeVisible();
      await expect(trigger.locator("svg")).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.emulateMedia({ reducedMotion: "reduce" });
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        await attachScreenshot(`picker-long-${device}-${theme}.png`);
      }
    });

    test("the folder menu of a dialogue keeps its chevron at the right edge, and it does not turn", async ({ page, context, request, consoleErrors }) => {
      void consoleErrors;
      await start(page, context, request, SHORT);
      await page.getByRole("listbox", { name: "Диалоги" }).getByRole("option", { name: /Анна Смирнова/ }).click();
      const folder = page.getByRole("button", { name: "Папка диалога Без папки" });
      await expect(folder).toBeEnabled();
      const field = await folder.evaluate((button) => {
        const style = getComputedStyle(button);
        return {
          gap: style.columnGap,
          grow: getComputedStyle(button.querySelector("span")!).flexGrow,
          // The inner right edge: the border box less the right border and padding.
          end: button.getBoundingClientRect().right - Number.parseFloat(style.borderRightWidth) - Number.parseFloat(style.paddingRight),
          chevron: button.querySelector("svg")!.getBoundingClientRect().right,
        };
      });
      expect(field.gap).toBe("6px");
      expect(field.grow).toBe("1");
      expect(field.chevron).toBeCloseTo(field.end, 1);
      const icon = folder.locator("svg");
      await expect(icon).toHaveCSS("transition-duration", "0s");
      await folder.click();
      await expect(menu(page)).toBeVisible();
      await expect(folder).toHaveAttribute("data-state", "open");
      await expect(icon).toHaveCSS("transform", "none");
      await page.keyboard.press("Escape");
      await expect(menu(page)).toBeHidden();
      await expect(folder).toBeFocused();
    });
  });
}
