import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OFFLINE } from "../api/client";
import { CHECK_TIMEOUT, RETRY_DELAYS, RETRYING, useSessionStore } from "./session";

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
    await session.check(Promise.resolve(json(200, { account: ACCOUNT, csrf: "c" })), new AbortController());
    expect(session.status).toBe("signed-in");
    expect(session.account?.login).toBe("operator");
    expect(session.csrf).toBe("c");
  });

  it("shows the sign-in form without a message on 401", async () => {
    const session = useSessionStore();
    await session.check(Promise.resolve(json(401, { detail: "Войдите в панель." })), new AbortController());
    expect(session.status).toBe("signed-out");
    expect(session.notice).toBe("");
  });

  it("keeps checking after server and network errors, then signs in", async () => {
    const fetch = vi.fn(async () => json(200, { account: ACCOUNT, csrf: "c" }));
    vi.stubGlobal("fetch", fetch);
    const session = useSessionStore();
    await session.check(Promise.resolve(json(429, { detail: "Слишком много запросов." })), new AbortController());
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
    await offline.check(Promise.reject(new TypeError("Failed to fetch")), new AbortController());
    expect(offline.notice).toBe(`${OFFLINE} ${RETRYING}`);
  });

  it("gives up on a check without an answer and retries it like a lost connection", async () => {
    // Every retry stalls as well: each one must be bounded by its own deadline.
    const retries: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((_path: string, init: RequestInit) => {
      retries.push(init.signal as AbortSignal);
      return new Promise<Response>(() => undefined);
    }));
    const session = useSessionStore();
    const controller = new AbortController();
    void session.check(new Promise<Response>(() => undefined), controller);
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT - 1);
    expect(session.status).toBe("checking");
    expect(controller.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.signal.aborted).toBe(true);
    expect(session.status).toBe("signed-out");
    expect(session.notice).toBe(`${OFFLINE} ${RETRYING}`);

    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]!);
    expect(retries).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT);
    expect(retries[0]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[1]!);
    expect(retries).toHaveLength(2);
  });

  it("gives up on a check whose body stalls after the headers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { account: ACCOUNT, csrf: "c" })));
    const session = useSessionStore();
    const controller = new AbortController();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const stalled = new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        body = stream;
        stream.enqueue(new TextEncoder().encode('{"account":'));
      },
    }), { status: 200 });
    // As with a real request, aborting it errors the body, which readResult() turns into {}.
    controller.signal.addEventListener("abort", () => body.error(new DOMException("Aborted", "AbortError")));
    void session.check(Promise.resolve(stalled), controller);
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT);
    await flush();
    expect(controller.signal.aborted).toBe(true);
    expect(session.status).toBe("signed-out");
    expect(session.account).toBeNull();
    expect(session.notice).toBe(`${OFFLINE} ${RETRYING}`);

    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]!);
    await flush();
    expect(session.status).toBe("signed-in");
  });

  it("ignores a stale check answer once the operator has signed in with the form", async () => {
    const session = useSessionStore();
    let answer!: (response: Response) => void;
    const pending = session.check(new Promise<Response>((resolve) => { answer = resolve; }), new AbortController());
    session.signIn({ account: ACCOUNT as never, csrf: "fresh" });
    answer(json(401, { detail: "Войдите в панель." }));
    await pending;
    expect(session.status).toBe("signed-in");
    expect(session.csrf).toBe("fresh");
  });

  it("does not end a new session for a 401 answering a request of the previous one", async () => {
    const session = useSessionStore();
    session.signIn({ account: ACCOUNT as never, csrf: "old" });
    let answer!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
    const stale = session.api("projects");
    // The operator signs out and back in while the request is still pending.
    session.signOut();
    session.signIn({ account: ACCOUNT as never, csrf: "new" });
    const ended = vi.fn();
    session.onSessionEnd(ended);
    answer(json(401, { detail: "Сессия завершена. Войдите снова." }));
    await expect(stale).rejects.toThrow("Сессия завершена. Войдите снова.");
    expect(session.status).toBe("signed-in");
    expect(session.account?.login).toBe("operator");
    expect(session.csrf).toBe("new");
    expect(ended).not.toHaveBeenCalled();
  });

  it("ends the session for a 401 answering a request of the current one", async () => {
    const session = useSessionStore();
    session.signIn({ account: ACCOUNT as never, csrf: "c" });
    const ended = vi.fn();
    session.onSessionEnd(ended);
    vi.stubGlobal("fetch", vi.fn(async () => json(401, { detail: "Сессия завершена. Войдите снова." })));
    await expect(session.api("projects")).rejects.toThrow();
    expect(session.status).toBe("signed-out");
    expect(session.csrf).toBe("");
    expect(ended).toHaveBeenCalledOnce();
  });

  it("stops retrying once a check answers 401", async () => {
    const fetch = vi.fn(async () => json(401, { detail: "Войдите в панель." }));
    vi.stubGlobal("fetch", fetch);
    const session = useSessionStore();
    await session.check(Promise.resolve(json(502, "")), new AbortController());
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]!);
    await flush();
    expect(fetch).toHaveBeenCalledOnce();
    expect(session.notice).toBe("");
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS.at(-1)! * 2);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
