import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";

export const PASSWORD = "correct horse battery";
export const SESSION_COOKIE = { name: "resolvate_session", value: "stub-session", domain: "127.0.0.1", path: "/console" };

export interface Probe {
  themes: string[];
  loginSeen: boolean;
  violations: string[];
}

/** Installed before any page script: records every theme value, the sign-in form and CSP violations. */
function installProbe(): void {
  const probe = { themes: [] as string[], loginSeen: false, violations: [] as string[] };
  Object.assign(window, { __probe: probe });
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes" && record.target === document.documentElement) {
        probe.themes.push(document.documentElement.dataset.theme ?? "");
      }
      for (const node of record.addedNodes) {
        if (node instanceof Element && (node.id === "login-screen" || node.querySelector("#login-screen"))) {
          probe.loginSeen = true;
        }
      }
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-theme"] });
  document.addEventListener("securitypolicyviolation", (event) => {
    probe.violations.push(`${event.effectiveDirective} ${event.blockedURI}`);
  });
}

export async function scenario(request: APIRequestContext, value: object): Promise<void> {
  await request.post("/__stub/scenario", { data: value });
}

export async function probe(page: Page): Promise<Probe> {
  return page.evaluate(() => (window as unknown as { __probe: Probe }).__probe);
}

export async function stubLog(
  request: APIRequestContext,
): Promise<{ method: string; path: string; at: number; aborted?: boolean }[]> {
  return (await request.get("/__stub/log")).json();
}

export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (/Refused to|Content[- ]Security[- ]Policy/i.test(message.text())) errors.push(message.text());
    });
    await page.addInitScript(installProbe);
    await use(errors);
    // No scenario may trip the console CSP, in any engine.
    expect(errors).toEqual([]);
    expect((await probe(page)).violations).toEqual([]);
  },
});

export { expect };
