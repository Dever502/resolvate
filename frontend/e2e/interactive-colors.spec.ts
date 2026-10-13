import type { APIRequestContext, BrowserContext, Locator, Page } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, test } from "./fixtures";

// Interactive colors follow the surface they sit on (styles/app.css .chrome), not the theme: the dark
// app bar keeps dark hover and pressed fills, bright text and a visible focus ring in every theme, and
// light surfaces keep their own. Colors are read as the browser renders them (a canvas turns any CSS
// color, color-mix() included, into sRGB) and checked by WCAG contrast, not by screenshots.
type RGB = [number, number, number];
interface Paint { background: RGB; alpha: number; text: RGB; outline: RGB; outlineStyle: string; outlineWidth: number }

const bar = (page: Page) => page.getByRole("banner", { name: "Проект и управление" });
const replies = (page: Page) => bar(page).getByRole("button", { name: "Управление готовыми ответами" });
const admin = (page: Page) => bar(page).getByRole("button", { name: "Управление", exact: true });
const picker = (page: Page) => bar(page).getByRole("button", { name: /^Текущий проект/ });

function luminance([r, g, b]: RGB): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(a: RGB, b: RGB): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** The element's colors as painted, once its transitions have run; a transparent fill shows the surface below it. */
async function paint(locator: Locator): Promise<Paint> {
  return locator.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const read = (color: string): [number, number, number, number] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!, a!];
    };
    const style = getComputedStyle(element);
    let [r, g, b, a] = read(style.backgroundColor);
    // Transparent: the nearest ancestor with a fill (the bar, or the sidebar) is what shows.
    for (let parent = element.parentElement; a === 0 && parent; parent = parent.parentElement) [r, g, b, a] = read(getComputedStyle(parent).backgroundColor);
    const text = read(style.color);
    const outline = read(style.outlineColor);
    return {
      background: [r, g, b], alpha: a, text: [text[0], text[1], text[2]], outline: [outline[0], outline[1], outline[2]],
      outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth),
    };
  });
}

async function start(page: Page, context: BrowserContext, request: APIRequestContext, theme: string, data: object = {}): Promise<void> {
  await scenario(request, { me: "session", data });
  await context.addCookies([SESSION_COOKIE]);
  await page.addInitScript((value) => localStorage.setItem("resolvate.theme", value), theme);
  await page.goto("/console/");
  await expect(page.locator("#workspace")).toBeVisible();
}

/**
 * Reaches the control with the keyboard, so :focus-visible applies as it does for a keyboard user:
 * one step on and back (from the page's first control, Shift+Tab would leave the page in Firefox).
 */
async function tabTo(page: Page, control: Locator): Promise<void> {
  await control.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(control).toBeFocused();
}

const themes = [
  { name: "light", stored: "light", scheme: "light" },
  { name: "dark", stored: "dark", scheme: "dark" },
  { name: "system (light)", stored: "system", scheme: "light" },
  { name: "system (dark)", stored: "system", scheme: "dark" },
] as const;

for (const theme of themes) {
  test.describe(theme.name, () => {
    // consoleErrors first: its CSP probe must be in the page before the page loads.
    test.beforeEach(async ({ page, context, request, consoleErrors }) => {
      void consoleErrors;
      await page.emulateMedia({ colorScheme: theme.scheme });
      // The installation administrator has both controls of the bar: quick replies and administration.
      await start(page, context, request, theme.stored, { account: "admin" });
      // The bar itself stays dark whatever the theme.
      expect(luminance((await paint(bar(page))).background)).toBeLessThan(0.05);
    });

    test("hover and pressed keep a dark fill on the app bar, with readable text", async ({ page, consoleErrors }) => {
      void consoleErrors;
      const surface = (await paint(bar(page))).background;
      for (const control of [replies(page), admin(page)]) {
        const rest = await paint(control);
        expect(contrast(rest.text, rest.background)).toBeGreaterThanOrEqual(4.5);
        // Hover: a fill a little lighter than the bar, never the light page's hover; the text stays readable.
        await control.hover();
        const hover = await paint(control);
        expect(hover.alpha).toBe(255);
        expect(luminance(hover.background)).toBeGreaterThan(luminance(surface));
        expect(luminance(hover.background)).toBeLessThan(0.15);
        expect(contrast(hover.text, hover.background)).toBeGreaterThanOrEqual(4.5);
        // Pressed: a step further, still dark. The pointer leaves before it is released: no click.
        await page.mouse.down();
        const pressed = await paint(control);
        await page.mouse.move(0, 0);
        await page.mouse.up();
        expect(luminance(pressed.background)).toBeGreaterThan(luminance(hover.background));
        expect(luminance(pressed.background)).toBeLessThan(0.15);
        expect(contrast(pressed.text, pressed.background)).toBeGreaterThanOrEqual(4.5);
      }
    });

    test("the focus ring on the app bar is a ring, not a fill, and stands out from the bar and its hover", async ({ page, consoleErrors }) => {
      void consoleErrors;
      const surface = (await paint(bar(page))).background;
      for (const control of [replies(page), admin(page), picker(page)]) {
        await control.hover();
        const hover = await paint(control);
        await page.mouse.move(0, 0);
        await tabTo(page, control);
        const focused = await paint(control);
        expect(focused.outlineStyle).toBe("solid");
        expect(focused.outlineWidth).toBeGreaterThanOrEqual(2);
        expect(contrast(focused.outline, surface)).toBeGreaterThanOrEqual(3);
        expect(contrast(focused.outline, hover.background)).toBeGreaterThanOrEqual(3);
        expect(focused.outline).not.toEqual(hover.background);
      }
    });
  });
}

test("light surfaces keep their own hover: the light theme's fill and text, not the bar's", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await page.emulateMedia({ colorScheme: "light" });
  await start(page, context, request, "light");
  const archive = page.getByRole("button", { name: "Открыть архив" });
  await archive.hover();
  const hover = await paint(archive);
  // --hover and --text of the light theme (app.css :root).
  expect(hover.background).toEqual([0xe2, 0xe6, 0xee]);
  expect(hover.text).toEqual([0x23, 0x28, 0x35]);
  await tabTo(page, archive);
  // The page's focus ring is still the accent (#365ab5).
  expect((await paint(archive)).outline).toEqual([0x36, 0x5a, 0xb5]);
});

test("a disabled app bar control gets no hover fill", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await page.emulateMedia({ colorScheme: "light" });
  await start(page, context, request, "light", { account: "admin", noProjects: true });
  await expect(replies(page)).toBeDisabled();
  const surface = (await paint(bar(page))).background;
  await replies(page).hover({ force: true });
  const hover = await paint(replies(page));
  expect(hover.background).toEqual(surface);
});
