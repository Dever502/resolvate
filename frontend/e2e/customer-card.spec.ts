import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, test } from "./fixtures";

// The customer card (chat/CustomerCard.vue, lib/customerFields.ts) names the customer's identity by its provider, as
// the server returns it with the ticket: «Telegram ID», «Внешний ID», an email identity as the one Email row, an
// unknown provider neutrally. The stub serves the providers the server has. Every test also fails on a CSP violation
// or a console error.
const card = (page: Page) => page.locator("#customer-card");

async function start(page: Page, context: BrowserContext, request: APIRequestContext, width = 1280): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await scenario(request, { me: "session" });
  await context.addCookies([SESSION_COOKIE]);
  await page.goto("/console/");
}

/** Opens a dialogue and its card; the card's rows as label → value. */
async function rows(page: Page, name: RegExp): Promise<Record<string, string>> {
  await page.getByRole("listbox", { name: "Диалоги" }).getByRole("option", { name }).click();
  await expect(page.getByRole("textbox", { name: "Текст ответа" })).toBeEditable();
  if (!(await card(page).isVisible())) await page.locator("#customer-open").click();
  await expect(card(page)).toBeVisible();
  // The detail is in: the card's last row is the first contact.
  await expect(card(page).locator("dt").last()).toHaveText("Первое обращение");
  return card(page).evaluate((element) => {
    const out: Record<string, string> = {};
    const terms = [...element.querySelectorAll("dt")];
    for (const term of terms) out[term.textContent!.trim()] = (term.nextElementSibling as HTMLElement).textContent!.trim();
    return out;
  });
}

/** Rewrites the ticket's detail as the server could send it. */
async function detail(page: Page, ticket: string, fields: Record<string, unknown>): Promise<void> {
  await page.route(`**/console/projects/*/tickets/${ticket}`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), ...fields } });
  });
}

test("a Telegram customer's ID is «Telegram ID»; an email identity is the one Email row; switching shows no stale rows", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await start(page, context, request);
  const anna = await rows(page, /Анна Смирнова/);
  expect(anna["Telegram ID"]).toBe("100001");
  expect(anna).not.toHaveProperty("Идентификатор");
  expect(anna).not.toHaveProperty("Email");
  const boris = await rows(page, /Борис Петров/);
  expect(boris.Email).toBe("boris@example.com");
  expect(Object.keys(boris).filter((label) => label === "Email" || label === "Идентификатор")).toEqual(["Email"]);
  expect(boris).not.toHaveProperty("Telegram ID");
  expect(await card(page).getByText("boris@example.com").count()).toBe(1);
});

test("a site's own customer ID is «Внешний ID», long values wrap, the Remnawave ID stays as it was", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  const external = `crm-${"7f3a9b2c".repeat(8)}`;
  const uuid = "8c2f6a7e-1111-4222-8333-944445555666";
  await detail(page, "t2", { email: null, identity_provider: "web_external_id", identity_value: external, remnawave_user_uuid: uuid });
  await start(page, context, request);
  const boris = await rows(page, /Борис Петров/);
  expect(boris["Внешний ID"]).toBe(external);
  expect(boris["Remnawave ID"]).toBe(uuid);
  expect(boris).not.toHaveProperty("Telegram ID");
  expect(boris).not.toHaveProperty("Email");
  const value = card(page).locator("dd").filter({ hasText: external });
  expect(await value.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await card(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("an email only in the identity is still shown as the Email; an unknown provider is named neutrally", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  let fields: Record<string, unknown> = { email: null, identity_provider: "web_email", identity_value: "only@identity.example" };
  await page.route("**/console/projects/*/tickets/t2", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), ...fields } });
  });
  await start(page, context, request);
  const only = await rows(page, /Борис Петров/);
  expect(only.Email).toBe("only@identity.example");
  expect(only).not.toHaveProperty("Идентификатор");
  fields = { identity_provider: "partner_sso", identity_value: "partner-77" };
  await page.reload();
  const unknown = await rows(page, /Борис Петров/);
  expect(unknown["Идентификатор"]).toBe("partner-77");
  expect(unknown).not.toHaveProperty("Telegram ID");
  expect(unknown).not.toHaveProperty("Внешний ID");
});

for (const [device, width] of [["desktop", 1280], ["phone", 375]] as const) {
  test(`the card on ${device}, light and dark`, async ({ page, context, request, consoleErrors, attachScreenshot, browserName }, testInfo) => {
    void consoleErrors;
    await start(page, context, request, width);
    const anna = await rows(page, /Анна Смирнова/);
    expect(anna["Telegram ID"]).toBe("100001");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await attachScreenshot(`customer-card-${device}-${theme}`);
      if (browserName === "chromium") await page.screenshot({ path: testInfo.outputPath(`customer-card-${device}-${theme}.png`) });
    }
    // It still closes and gives the focus back to the customer's name.
    await card(page).getByRole("button", { name: "Закрыть карточку" }).click();
    await expect(card(page)).toHaveCount(0);
    await expect(page.locator("#customer-open")).toBeFocused();
  });
}
