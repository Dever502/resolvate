import type { BrowserContext, Page } from "@playwright/test";
import { SESSION_COOKIE, expect, scenario, test } from "./fixtures";

// Loading placeholders (projects/ProjectPicker.vue, chat/DialogueHeader.vue, folders/TicketFolderMenu.vue,
// composer/Composer.vue): while the tab's place is restored, the parts not loaded yet keep their shape as
// placeholders and never show a made-up state ("Выберите проект", "Клиент", "Без папки", an empty reply
// box); what is already known shows at once; a failure ends the placeholder. Responses are held back by
// the test. Every test also fails on a CSP violation or a console error.
const list = (page: Page) => page.getByRole("listbox", { name: "Диалоги" });
const header = (page: Page) => page.locator("#customer-open");
const composer = (page: Page) => page.getByRole("textbox", { name: "Текст ответа" });

/** A gate the test opens: requests wait behind it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

async function signIn(_page: Page, context: BrowserContext): Promise<void> {
  await context.addCookies([SESSION_COOKIE]);
}

test("a slow project list: the picker is a placeholder of its own size, then the restored project, never another first", async ({ page, context, request, consoleErrors, attachScreenshot }) => {
  void consoleErrors;
  await page.setViewportSize({ width: 1280, height: 800 });
  await scenario(request, { me: "session" });
  await signIn(page, context);
  // The tab worked in the second project before the reload.
  await page.goto("/console/");
  await page.getByRole("button", { name: /^Текущий проект/ }).click();
  await page.getByRole("menuitemradio", { name: "Второй проект" }).click();
  await expect(page.getByRole("button", { name: /^Текущий проект/ })).toHaveAccessibleName("Текущий проект Второй проект");
  const ready = (await page.locator("#workspace > header .project-picker").boundingBox())!;
  const held = gate();
  await page.route("**/console/projects", async (route) => {
    if (route.request().method() === "GET") await held.wait;
    await route.continue();
  });
  // Every name the bar shows on the way is noted.
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.assign(window, { __seen: seen });
    new MutationObserver(() => {
      const text = document.querySelector("#workspace > header")?.textContent ?? "";
      if (text && seen.at(-1) !== text) seen.push(text);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  await page.reload();
  // The desktop picker (the narrow screens' menu button is hidden at this width).
  const busy = page.locator("#workspace > header [aria-busy='true']").filter({ visible: true });
  await expect(busy).toBeVisible();
  await expect(busy.locator(".skeleton")).toHaveCount(3);
  await attachScreenshot("loading-project-picker");
  const placeholder = (await busy.boundingBox())!;
  held.open();
  await expect(page.getByRole("button", { name: /^Текущий проект/ })).toHaveAccessibleName("Текущий проект Второй проект");
  const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
  expect(seen.some((text) => text.includes("Выберите проект"))).toBe(false);
  expect(seen.some((text) => text.includes("Поддержка"))).toBe(false);
  // The placeholder took the picker's room: nothing moved when it was replaced.
  expect(Math.abs(placeholder.height - ready.height)).toBeLessThanOrEqual(2);
});

test("no projects at all: the real empty state, no placeholder", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await scenario(request, { me: "session", data: { noProjects: true } });
  await signIn(page, context);
  await page.goto("/console/");
  await expect(page.getByRole("button", { name: /^Текущий проект/ })).toContainText("Выберите проект");
  await expect(page.locator("#workspace > header .skeleton")).toHaveCount(0);
});

test("a project list that fails ends the placeholder and says so", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await scenario(request, { me: "session" });
  await signIn(page, context);
  await page.route("**/console/projects", (route) => (route.request().method() === "GET"
    ? route.fulfill({ status: 503, json: { detail: "Сервис недоступен." } })
    : route.continue()));
  await page.goto("/console/");
  await expect(page.getByRole("button", { name: /^Текущий проект/ })).toContainText("Проекты не загрузились");
  await expect(page.locator("#workspace > header .skeleton")).toHaveCount(0);
  await expect(page.locator("#workspace > header [aria-busy='true']")).toHaveCount(0);
});

test("a dialogue restored before anything about it is known: header, folder and action are placeholders, then the real ones", async ({ page, context, request, consoleErrors, attachScreenshot, browserName }, testInfo) => {
  void consoleErrors;
  await page.setViewportSize({ width: 1280, height: 800 });
  await scenario(request, { me: "session" });
  await signIn(page, context);
  await page.goto("/console/");
  await list(page).getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(composer(page)).toBeEditable();
  // After the reload the list and the dialogue's detail both wait.
  const held = gate();
  for (const path of ["**/console/projects/p1/tickets/sync", "**/console/projects/p1/tickets/t1"]) {
    await page.route(path, async (route) => {
      await held.wait;
      await route.continue();
    });
  }
  await page.reload();
  await expect(header(page)).toHaveAttribute("aria-busy", "true");
  await expect(header(page).locator(".skeleton")).toHaveCount(3);
  await expect(header(page)).not.toContainText("Клиент");
  await expect(page.locator(".header-action-skeleton")).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Завершить|Возобновить)$/ })).toHaveCount(0);
  await expect(page.locator(".folder-select-skeleton")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Папка диалога/ })).toHaveCount(0);
  await attachScreenshot("loading-dialogue");
  if (browserName === "chromium") await page.locator("#workspace main").screenshot({ path: testInfo.outputPath("loading-dialogue.png") });
  held.open();
  await expect(header(page)).toContainText("Анна Смирнова");
  await expect(header(page)).not.toHaveAttribute("aria-busy");
  await expect(page.getByRole("button", { name: "Завершить" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Папка диалога/ })).toContainText("Без папки");
  await expect(page.locator("#workspace main .skeleton")).toHaveCount(0);
});

test("a restored dialogue whose list row comes first shows the row's name and action, only the folder waits", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await scenario(request, { me: "session" });
  await signIn(page, context);
  await page.goto("/console/");
  await list(page).getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(composer(page)).toBeEditable();
  const held = gate();
  await page.route("**/console/projects/p1/tickets/t1", async (route) => {
    await held.wait;
    await route.continue();
  });
  await page.reload();
  await expect(list(page).getByRole("option", { name: /Анна Смирнова/ })).toBeVisible();
  await expect(header(page)).toContainText("Анна Смирнова");
  await expect(header(page)).not.toHaveAttribute("aria-busy");
  await expect(header(page).locator(".skeleton")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Завершить" })).toBeVisible();
  await expect(page.locator(".folder-select-skeleton")).toBeVisible();
  held.open();
  await expect(page.getByRole("button", { name: /^Папка диалога/ })).toContainText("Без папки");
  await expect(page.locator("#workspace main .skeleton")).toHaveCount(0);
});

test("a dialogue opened from the list shows its name at once; only the folder waits for the detail", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await scenario(request, { me: "session" });
  await signIn(page, context);
  await page.goto("/console/");
  const held = gate();
  await page.route("**/console/projects/p1/tickets/t2", async (route) => {
    await held.wait;
    await route.continue();
  });
  await list(page).getByRole("option", { name: /Борис Петров/ }).click();
  await expect(header(page)).toContainText("Борис Петров");
  await expect(header(page).locator(".skeleton")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Завершить" })).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator(".folder-select-skeleton")).toBeVisible();
  held.open();
  await expect(page.getByRole("button", { name: /^Папка диалога/ })).toContainText("VIP");
  await expect(page.locator(".folder-select-skeleton")).toHaveCount(0);
  // A live refresh of the open dialogue brings no placeholder back.
  await request.post("/__stub/incoming", { data: { ticket: "t2", text: "Ещё вопрос" } });
  await expect(page.getByRole("region", { name: "Переписка" }).getByText("Ещё вопрос")).toBeVisible();
  await expect(page.locator("#workspace main .skeleton")).toHaveCount(0);
});

test("a detail that fails ends the placeholders: the dialogue says what it has", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await scenario(request, { me: "session" });
  await signIn(page, context);
  await page.goto("/console/");
  await list(page).getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(composer(page)).toBeEditable();
  await page.route("**/console/projects/p1/tickets/sync", async (route) => route.fulfill({ status: 503, json: { detail: "Сервис недоступен." } }));
  await page.route("**/console/projects/p1/tickets/t1", async (route) => route.fulfill({ status: 503, json: { detail: "Сервис недоступен." } }));
  await page.reload();
  await expect(page.getByRole("region", { name: "Диалог" })).toBeVisible();
  await expect(page.locator("#workspace main .skeleton")).toHaveCount(0);
  await expect(header(page)).not.toHaveAttribute("aria-busy");
});

test("the reply box takes no input until the dialogue's stored draft is read, then shows the draft", async ({ page, context, request, consoleErrors }) => {
  void consoleErrors;
  await scenario(request, { me: "session" });
  await signIn(page, context);
  await page.goto("/console/");
  await list(page).getByRole("option", { name: /Анна Смирнова/ }).click();
  await expect(composer(page)).toBeEditable();
  await composer(page).fill("Сохранённый черновик");
  await expect.poll(() => page.evaluate(() => new Promise<string | null>((resolve) => {
    const request = indexedDB.open("resolvate-work");
    request.onsuccess = () => {
      const read = request.result.transaction("drafts").objectStore("drafts").getAll();
      read.onsuccess = () => {
        request.result.close();
        resolve((read.result as { text: string }[])[0]?.text ?? null);
      };
    };
  }))).toBe("Сохранённый черновик");
  // The browser's storage answers only when the test lets it.
  await page.addInitScript(() => {
    const open = IDBFactory.prototype.open;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    Object.assign(window, { __openStorage: release });
    IDBFactory.prototype.open = function (this: IDBFactory, ...args: Parameters<IDBFactory["open"]>): IDBOpenDBRequest {
      const waiting: Record<string, unknown> = {};
      void held.then(() => {
        const real = open.apply(this, args);
        for (const name of ["onupgradeneeded", "onsuccess", "onerror", "onblocked"] as const) {
          real[name] = (event: Event) => (waiting[name] as ((event: Event) => void) | undefined)?.(event);
        }
        Object.defineProperties(waiting, { result: { get: () => real.result }, error: { get: () => real.error } });
      });
      return waiting as unknown as IDBOpenDBRequest;
    };
  });
  await page.reload();
  await expect(composer(page)).toHaveAttribute("readonly", "");
  await expect(composer(page)).toHaveAttribute("placeholder", "Черновик загружается…");
  await expect(page.locator("form.composer")).toHaveAttribute("aria-busy", "true");
  await composer(page).focus();
  await page.keyboard.type("лишнее");
  await expect(composer(page)).toHaveValue("");
  await page.evaluate(() => (window as unknown as { __openStorage: () => void }).__openStorage());
  await expect(composer(page)).toHaveValue("Сохранённый черновик");
  await expect(composer(page)).toBeEditable();
  await expect(composer(page)).toHaveAttribute("placeholder", "Написать ответ…");
  await expect(page.locator("form.composer")).not.toHaveAttribute("aria-busy");
});
