import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OFFLINE, RETRY_DELAYS, RETRYING, useSessionStore } from "./session";

const ACCOUNT = { id: "a1", login: "operator", name: "Оператор", role: "operator", active: true, telegram_id: null };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });
const flush = async (): Promise<void> => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};

describe("session store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("signs in from a successful check", async () => {
    const session = useSessionStore();
    await session.check(Promise.resolve(json(200, { account: ACCOUNT, csrf: "c" })));
    expect(session.status).toBe("signed-in");
    expect(session.account?.login).toBe("operator");
    expect(session.csrf).toBe("c");
  });

  it("shows the sign-in form without a message on 401", async () => {
    const session = useSessionStore();
    await session.check(Promise.resolve(json(401, { detail: "Войдите в панель." })));
    expect(session.status).toBe("signed-out");
    expect(session.notice).toBe("");
  });

  it("keeps checking after server and network errors, then signs in", async () => {
    const fetch = vi.fn(async () => json(200, { account: ACCOUNT, csrf: "c" }));
    vi.stubGlobal("fetch", fetch);
    const session = useSessionStore();
    await session.check(Promise.resolve(json(429, { detail: "Слишком много запросов." })));
    expect(session.status).toBe("signed-out");
    expect(session.notice).toBe(`Слишком много запросов. ${RETRYING}`);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]!);
    await flush();
    expect(fetch).toHaveBeenCalledWith("/console/me", expect.anything());
    expect(session.status).toBe("signed-in");
    expect(session.notice).toBe("");

    const offline = useSessionStore();
    offline.signOut();
    await offline.check(Promise.reject(new TypeError("Failed to fetch")));
    expect(offline.notice).toBe(`${OFFLINE} ${RETRYING}`);
  });

  it("ignores a stale check answer once the operator has signed in with the form", async () => {
    const session = useSessionStore();
    let answer!: (response: Response) => void;
    const pending = session.check(new Promise<Response>((resolve) => { answer = resolve; }));
    session.signIn({ account: ACCOUNT as never, csrf: "fresh" });
    answer(json(401, { detail: "Войдите в панель." }));
    await pending;
    expect(session.status).toBe("signed-in");
    expect(session.csrf).toBe("fresh");
  });

  it("ends the session only for a 401 answering the current session", async () => {
    const session = useSessionStore();
    session.signIn({ account: ACCOUNT as never, csrf: "c" });
    const ended = vi.fn();
    session.onSessionEnd(ended);
    vi.stubGlobal("fetch", vi.fn(async () => json(401, { detail: "Сессия завершена. Войдите снова." })));
    const stale = session.generation - 1;
    session.signIn({ account: ACCOUNT as never, csrf: "c2" });
    // A request from the previous session: its 401 must not sign out the new one.
    const { request } = await import("../api/client");
    await expect(request("projects", {}, { csrf: "", project: null, generation: stale }, () => undefined)).rejects.toThrow();
    expect(session.status).toBe("signed-in");
    await expect(session.api("projects")).rejects.toThrow();
    expect(session.status).toBe("signed-out");
    expect(ended).toHaveBeenCalledOnce();
  });

  it("stops retrying once a check answers 401", async () => {
    const fetch = vi.fn(async () => json(401, { detail: "Войдите в панель." }));
    vi.stubGlobal("fetch", fetch);
    const session = useSessionStore();
    await session.check(Promise.resolve(json(502, "")));
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]!);
    await flush();
    expect(fetch).toHaveBeenCalledOnce();
    expect(session.notice).toBe("");
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS.at(-1)! * 2);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
