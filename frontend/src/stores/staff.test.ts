import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "../api/types";
import { PASSWORD_CHANGED, useSessionStore } from "./session";
import { useStaffStore } from "./staff";

const ADMIN: Account = { id: "a0", login: "admin", name: "Админ", role: "admin", active: true, telegram_id: null };
const PAVEL: Account = { id: "a3", login: "pavel", name: "Павел", role: "operator", active: true, telegram_id: null };

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function server(answer: (call: Call) => [number, unknown]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const call = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const [status, body] = answer(call);
    return new Response(JSON.stringify(body), { status });
  }));
  return calls;
}

describe("staff of the installation", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useSessionStore().signIn({ account: ADMIN, csrf: "c" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("creates operators only and reloads the list; the server's refusal reaches the form", async () => {
    let accounts = [ADMIN];
    const calls = server((call) => {
      if (call.url === "/console/accounts" && call.method === "GET") return [200, accounts];
      const body = call.body as { login: string };
      if (body.login === "taken") return [409, { detail: "Логин или Telegram ID уже используется." }];
      accounts = [ADMIN, PAVEL];
      return [200, PAVEL];
    });
    const staff = useStaffStore();
    await staff.create({ name: "Павел", login: "pavel", password: "p".repeat(12), telegram_id: null });
    expect(calls[0]).toMatchObject({ method: "POST", body: { login: "pavel", role: "operator", telegram_id: null } });
    expect(staff.accounts.map((account) => account.login)).toEqual(["admin", "pavel"]);
    await expect(staff.create({ name: "X", login: "taken", password: "p".repeat(12), telegram_id: 5 }))
      .rejects.toThrow("Логин или Telegram ID уже используется.");
  });

  it("switches accounts off and on and binds Telegram IDs through their routes", async () => {
    const calls = server((call) => [200, call.method === "GET" ? [ADMIN, PAVEL] : { ok: true }]);
    const staff = useStaffStore();
    await staff.setActive(PAVEL, false);
    await staff.setActive(PAVEL, true);
    await staff.setTelegramId(PAVEL, 4004);
    await staff.setTelegramId(PAVEL, null);
    expect(calls.filter((call) => call.method === "POST").map((call) => [call.url, call.body])).toEqual([
      ["/console/accounts/a3/disable", undefined],
      ["/console/accounts/a3/enable", undefined],
      ["/console/accounts/a3/identity/telegram", { telegram_id: 4004 }],
      ["/console/accounts/a3/identity/telegram", { telegram_id: null }],
    ]);
  });

  it("a change that succeeded is not reported as failed when only the reload fails", async () => {
    server((call) => (call.method === "GET" ? [500, { detail: "Нет связи." }] : [200, { ok: true }]));
    await expect(useStaffStore().setActive(PAVEL, false)).resolves.toBeUndefined();
  });

  it("drops a list that arrives after the session changed", async () => {
    let release!: () => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      release = () => resolve(new Response(JSON.stringify([ADMIN, PAVEL]), { status: 200 }));
    })));
    const staff = useStaffStore();
    const pending = staff.refresh();
    useSessionStore().signOut();
    release();
    await pending;
    expect(staff.accounts).toEqual([]);
    expect(staff.loaded).toBe(false);
  });
});

describe("passwords and the installation", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useSessionStore().signIn({ account: ADMIN, csrf: "c" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("resets an employee's password with the administrator's own current one, without ending this session", async () => {
    const calls = server(() => [200, { ok: true }]);
    await useStaffStore().resetPassword(PAVEL, "admin password", "new password 123");
    expect(calls).toEqual([{ url: "/console/accounts/a3/password", method: "POST", body: { current_password: "admin password", new_password: "new password 123" } }]);
    expect(useSessionStore().status).toBe("signed-in");
  });

  it("a reset of the own account ends this session like a change, because the server ended it", async () => {
    server(() => [200, { ok: true }]);
    await useStaffStore().resetPassword(ADMIN, "admin password", "new password 123");
    expect([useSessionStore().status, useSessionStore().notice]).toEqual(["signed-out", PASSWORD_CHANGED]);
  });

  it("hands the installation over by login, then signs out and says to whom", async () => {
    const calls = server(() => [200, { ok: true }]);
    await useStaffStore().transferInstallation(PAVEL);
    expect(calls).toEqual([{ url: "/console/installation/admin", method: "POST", body: { login: "pavel" } }]);
    const session = useSessionStore();
    expect([session.status, session.notice, session.noticeIsSuccess]).toEqual(["signed-out", "Управление установкой передано: Павел (pavel). Войдите снова.", true]);
  });

  it("keeps the session when the server refuses a transfer", async () => {
    server(() => [404, { detail: "Активная учётная запись с таким логином не найдена." }]);
    await expect(useStaffStore().transferInstallation(PAVEL)).rejects.toThrow("Активная учётная запись с таким логином не найдена.");
    expect(useSessionStore().status).toBe("signed-in");
  });
});
