import type { Page } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, test } from "./fixtures";

// The reply box's geometry and focus (app.css .composer): its buttons' corners are concentric with its own
// (14 px outside, 1 px border + 3 px padding, so 10 px inside), a keyboard focus ring stays inside the box, and the box
// lights up only for its text field, so a focused button shows one ring. Real computed styles in a real layout.
const input = (page: Page) => page.getByRole("textbox", { name: "Текст ответа" });

async function open(page: Page, context: import("@playwright/test").BrowserContext, request: import("@playwright/test").APIRequestContext, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await scenario(request, { me: "session" });
  await context.addCookies([SESSION_COOKIE]);
  await page.goto("/console/");
  await page.getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(input(page)).toBeEditable();
  await input(page).fill("Здравствуйте");
}

/** The focused element against the box: its corner, size, place, ring and how far the ring reaches past the box's inner edge. */
function focusState(page: Page) {
  return page.evaluate(() => {
    const box = document.querySelector<HTMLElement>(".composer")!;
    const css = getComputedStyle(box);
    const outer = box.getBoundingClientRect();
    const border = parseFloat(css.borderTopWidth);
    const element = document.activeElement as HTMLElement;
    const own = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const reach = own.outlineStyle === "none" ? 0 : parseFloat(own.outlineWidth) + parseFloat(own.outlineOffset);
    return {
      name: element.getAttribute("aria-label"),
      visible: element.matches(":focus-visible"),
      radius: own.borderTopLeftRadius,
      width: rect.width,
      height: rect.height,
      top: +(rect.top - outer.top).toFixed(2),
      bottom: +(outer.bottom - rect.bottom).toFixed(2),
      ring: { style: own.outlineStyle, width: own.outlineWidth, offset: own.outlineOffset, color: own.outlineColor },
      background: own.backgroundColor,
      over: +Math.max(
        outer.left + border - (rect.left - reach), outer.top + border - (rect.top - reach),
        rect.right + reach - (outer.right - border), rect.bottom + reach - (outer.bottom - border),
      ).toFixed(2),
      boxOutline: css.outlineStyle,
      boxBorder: css.borderTopColor,
    };
  });
}

for (const [width, height] of [[1280, 800], [375, 812], [320, 640]] as const) {
  test(`at ${width} px the buttons' corners are concentric with the box and their focus rings stay inside it`, async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await open(page, context, request, width, height);
    await input(page).evaluate((element) => element.blur());
    const box = await page.locator(".composer").evaluate((element) => {
      const css = getComputedStyle(element);
      return { radius: css.borderTopLeftRadius, border: css.borderTopWidth, padding: css.paddingTop, idleBorder: css.borderTopColor };
    });
    expect(box).toMatchObject({ radius: "14px", border: "1px", padding: "3px" });
    // The text field keeps its place and size: 4 px + two 44 px buttons and two 5 px gaps from the box's edge.
    const field = await input(page).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const outer = element.closest(".composer")!.getBoundingClientRect();
      return { left: Math.round(rect.left - outer.left), height: Math.round(rect.height) };
    });
    expect(field).toEqual({ left: 102, height: 40 });

    // The text field lights the box up.
    await input(page).focus();
    const text = await focusState(page);
    expect(text.boxOutline).toBe("solid");
    expect(text.boxBorder).not.toBe(box.idleBorder);

    const states: Awaited<ReturnType<typeof focusState>>[] = [];
    await page.keyboard.press("Tab");
    states.push(await focusState(page));
    await input(page).focus();
    await page.keyboard.press("Shift+Tab");
    states.push(await focusState(page));
    await page.keyboard.press("Shift+Tab");
    states.push(await focusState(page));
    expect(states.map((state) => state.name)).toEqual(["Отправить", "Готовые ответы", "Прикрепить файл"]);
    for (const state of states) {
      expect(state.visible, state.name!).toBe(true);
      // Concentric: 14 − (1 + 3) = 10 px, 4 px from the box's outer edge.
      expect(state.radius, state.name!).toBe("10px");
      expect([state.top, state.bottom], state.name!).toEqual([4, 4]);
      // A 44 px hit area as before.
      expect(state.height, state.name!).toBe(44);
      expect(state.width, state.name!).toBeGreaterThanOrEqual(44);
      // A visible ring that does not reach the box's border.
      expect(state.ring.style, state.name!).toBe("solid");
      expect(state.ring.width, state.name!).toBe("2px");
      expect(state.over, state.name!).toBeLessThanOrEqual(0);
      // One ring: the box is not lit up around a focused button.
      expect(state.boxOutline, state.name!).toBe("none");
      expect(state.boxBorder, state.name!).toBe(box.idleBorder);
    }
    // On the filled «Отправить» the ring is in its text colour, not its own background.
    const send = states[0]!;
    expect(send.ring.color).not.toBe(send.background);
    expect(send.ring.offset).toBe("-4px");
  });
}

test("the dark theme draws the ring in the send button's text colour; the transparent buttons keep the focus colour", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await open(page, context, request, 1280, 800);
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await input(page).focus();
  await page.keyboard.press("Tab");
  const send = await focusState(page);
  const onAccent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--on-accent").trim());
  expect(send.ring.color).toBe(await page.evaluate((value) => {
    const probe = document.createElement("span");
    probe.style.color = value;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, onAccent));
  expect(send.over).toBeLessThanOrEqual(0);
  await input(page).focus();
  await page.keyboard.press("Shift+Tab");
  const replies = await focusState(page);
  expect(replies.ring.color).not.toBe(send.ring.color);
  expect(replies.over).toBeLessThanOrEqual(0);
});

test.describe("forced colors and more contrast", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "forced colors are emulated in Chromium only");

  test("the ring stays visible and inside the box", async ({ page, context, request, consoleErrors }) => {
    void consoleErrors;
    await open(page, context, request, 1280, 800);
    for (const media of [{ forcedColors: "active" as const }, { forcedColors: "none" as const, contrast: "more" as const }]) {
      await page.emulateMedia(media);
      await input(page).focus();
      await page.keyboard.press("Tab");
      const send = await focusState(page);
      expect(send.ring.style).toBe("solid");
      expect(send.over).toBeLessThanOrEqual(0);
    }
  });
});
