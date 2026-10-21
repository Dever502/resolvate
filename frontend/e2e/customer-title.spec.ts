import type { Page } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, test } from "./fixtures";

// The customer's control in the dialogue header (chat/DialogueHeader.vue, app.css .customer-title): room
// around the avatar, name, channel and icon, the shared hover, pressed and focus states, a long name that
// stays clear of the close button on a narrow screen, and the customer card it opens.
const control = (page: Page) => page.locator("#customer-open");
const close = (page: Page) => page.getByRole("button", { name: "Завершить" });

for (const width of [1280, 375, 320]) {
  test(`at ${width} px the customer control has its room and a long name keeps clear of the close button`, async ({ page, context, request, consoleErrors, attachScreenshot, browserName }, testInfo) => {
    void consoleErrors;
    const name = "Анна-Мария Константинопольская-Достоевская".repeat(2);
    await page.route("**/console/projects/p1/tickets/t1", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), display_name: name } });
    });
    await page.setViewportSize({ width, height: 800 });
    await scenario(request, { me: "session" });
    await context.addCookies([SESSION_COOKIE]);
    await page.goto("/console/");
    await page.getByRole("option", { name: /Анна Смирнова/ }).click();
    await expect(control(page)).toContainText(name);
    const style = await control(page).evaluate((element) => {
      const css = getComputedStyle(element);
      return { top: parseFloat(css.paddingTop), bottom: parseFloat(css.paddingBottom), right: parseFloat(css.paddingRight), left: parseFloat(css.paddingLeft) };
    });
    expect(style.top).toBe(8);
    expect(style.bottom).toBe(8);
    expect(style.right).toBe(12);
    expect(style.left).toBeGreaterThanOrEqual(8);
    const box = (await control(page).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    const button = (await close(page).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(button.x);
    // The header keeps its height.
    const header = (await page.locator("#customer-open").locator("xpath=..").boundingBox())!;
    expect(header.height).toBeLessThanOrEqual(width > 700 ? 77 : 73);
    const strong = control(page).locator("strong");
    expect(await strong.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    // Hover and focus use the shared interactive states.
    await control(page).hover();
    const hover = await control(page).evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(hover).not.toBe("rgba(0, 0, 0, 0)");
    await page.mouse.move(0, 0);
    await page.keyboard.press("Tab");
    await control(page).focus();
    await expect(control(page)).toBeFocused();
    if (browserName === "chromium") await page.locator("#customer-open").locator("xpath=..").screenshot({ path: testInfo.outputPath(`customer-${width}.png`) });
    await attachScreenshot(`customer-${width}`);
    await control(page).click();
    await expect(control(page)).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#customer-card")).toBeVisible();
  });
}
