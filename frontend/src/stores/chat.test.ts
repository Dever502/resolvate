import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, MessagePage, TicketDetail } from "../api/types";
import {
  CACHE_AGE, FILE_TOO_LARGE, MAX_FILE_BYTES, SEND_BLOCKED, SEND_FOUND, SEND_REFRESH_FAILED, SEND_TIMEOUT, UNCERTAIN,
  UPLOAD_RATE, sendDeadline, useChatStore,
} from "./chat";
import { useProjectsStore } from "./projects";
import { useSessionStore } from "./session";
import { useWorkspaceStore } from "./workspace";

const ACCOUNT = { id: "a1", login: "operator", name: "Оператор", role: "operator" as const, active: true, telegram_id: null };

function message(id: string, minute: number, extra: Partial<Message> = {}): Message {
  return {
    id, direction: "user_to_operator", channel: "telegram", text: id, system: false, rating: null,
    time: `2026-10-07T10:${String(minute).padStart(2, "0")}:00Z`, author: "Клиент", media_id: null, mime: null,
    sticker: false, sticker_emoji: null, attachment: false, failed: [], uncertain: false, command: null,
    revision: `${id}-1`, ...extra,
  };
}

function detail(id: string, status: "open" | "closed" = "open"): TicketDetail {
  return {
    id, display_name: `Клиент ${id}`, username: null, channel: "telegram", status, email: null,
    identity_value: null, remnawave_user_uuid: null, created_at: "2026-10-01T00:00:00Z", folder_id: null, folder_revision: 0,
  };
}

const page = (items: Message[], extra: Partial<MessagePage> = {}): MessagePage => ({
  order: items.map((item) => item.id), items, removed: [], reset: false, before: "cursor", has_older: false, ...extra,
});

interface Call { path: string; init: RequestInit }

function api(handler: (path: string, init: RequestInit) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const path = url.replace(/^\/console\/projects\/p1\//, "");
    calls.push({ path, init });
    const result = await handler(path, init);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), { status: 200 });
  }));
  return calls;
}

describe("chat store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useSessionStore().signIn({ account: ACCOUNT, csrf: "c" });
    useProjectsStore().currentId = "p1";
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens a dialogue: detail and the newest history, sorted by time", async () => {
    const chat = useChatStore();
    api((path) => (path === "tickets/t1" ? detail("t1") : page([message("b", 2), message("a", 1)], { has_older: true })));
    await chat.open("t1");
    expect(chat.detail?.id).toBe("t1");
    expect(chat.ordered.map((item) => item.id)).toEqual(["a", "b"]);
    expect(chat.hasOlder).toBe(true);
    expect(useWorkspaceStore().dialogueOpen).toBe(true);
  });

  it("applies deltas: new and changed messages, removed ones, and a reset of a stale window", async () => {
    const chat = useChatStore();
    let answer = page([message("a", 1), message("b", 2)]);
    const calls = api((path) => (path === "tickets/t1" ? detail("t1") : answer));
    await chat.open("t1");
    answer = page([message("c", 3)], { order: ["b", "c"], removed: ["a"] });
    await chat.syncMessages();
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ known: { a: "a-1", b: "b-1" }, before: null });
    expect(chat.ordered.map((item) => item.id)).toEqual(["b", "c"]);
    answer = page([message("x", 9)], { reset: true, has_older: true, before: "fresh" });
    await chat.syncMessages();
    expect(chat.ordered.map((item) => item.id)).toEqual(["x"]);
    expect([chat.before, chat.hasOlder]).toEqual(["fresh", true]);
    expect(chat.change.kind).toBe("initial");
  });

  it("loads older pages with the cursor and an empty known map", async () => {
    const chat = useChatStore();
    const calls = api((path, init) => {
      if (path === "tickets/t1") return detail("t1");
      const body = JSON.parse(String(init.body)) as { before: string | null };
      return body.before ? page([message("old", 0)], { before: null, has_older: false }) : page([message("a", 1)], { has_older: true, before: "c1" });
    });
    await chat.open("t1");
    await chat.loadOlder();
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ known: {}, before: "c1" });
    expect(chat.ordered.map((item) => item.id)).toEqual(["old", "a"]);
    expect(chat.hasOlder).toBe(false);
    expect(chat.change.kind).toBe("older");
  });

  it("ignores answers for a dialogue the operator has already left", async () => {
    const chat = useChatStore();
    let slow!: (value: unknown) => void;
    api((path) => {
      if (path === "tickets/t1/sync") return new Promise((resolve) => { slow = resolve; });
      return path.endsWith("/sync") ? page([message("t2-message", 1)]) : detail(path.split("/")[1]!);
    });
    const first = chat.open("t1");
    await vi.waitFor(() => expect(slow).toBeDefined());
    await chat.open("t2");
    slow(new Response(JSON.stringify(page([message("t1-message", 1)]))));
    await first;
    expect(chat.ticketId).toBe("t2");
    expect(chat.ordered.map((item) => item.id)).toEqual(["t2-message"]);
  });

  it("shows a cached history at once for two minutes, then only after a reload", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const chat = useChatStore();
    let hold = false;
    api((path) => {
      if (hold && path === "tickets/t1/sync") return new Promise(() => undefined);
      return path.endsWith("/sync") ? page([message(`${path.split("/")[1]}-m`, 1)]) : detail(path.split("/")[1]!);
    });
    await chat.open("t1");
    await chat.open("t2");
    hold = true;
    void chat.open("t1");
    expect(chat.ordered.map((item) => item.id)).toEqual(["t1-m"]);
    // Cached metadata must not enable actions before the detail is authorized again.
    expect(chat.detail).toBeNull();
    hold = false;
    await chat.open("t2");
    vi.setSystemTime(Date.now() + CACHE_AGE + 1);
    hold = true;
    void chat.open("t1");
    expect(chat.ordered).toEqual([]);
  });

  it("marks a dialogue that answers 403 or 404 unavailable, so polling leaves it alone", async () => {
    const chat = useChatStore();
    api(() => new Response(JSON.stringify({ detail: "Диалог не найден." }), { status: 404 }));
    await expect(chat.open("t1")).rejects.toThrow("Диалог не найден.");
    expect(chat.unavailable).toBe(true);
    expect(chat.ordered).toEqual([]);
  });

  // A send's own request: its key and the text and file it carried.
  const sends = (calls: Call[]) => calls.filter((call) => call.path === "tickets/t1/send").map((call) => ({
    key: (call.init.headers as Record<string, string>)["X-Idempotency-Key"],
    text: (call.init.body as FormData).get("text"),
    file: (call.init.body as FormData).get("file"),
  }));
  const quiet = (path: string) => (path.endsWith("/sync") ? page([]) : path === "tickets/sync" ? { order: [], items: [] } : detail("t1"));

  it("a lost answer keeps the attempt; an edited draft neither changes it nor goes under its key", async () => {
    const chat = useChatStore();
    let lose = true;
    const calls = api((path) => {
      if (path !== "tickets/t1/send") return quiet(path);
      // The server saved the message, but the answer never reached the browser.
      if (lose) throw new TypeError("Failed to fetch");
      return { id: "m1" };
    });
    await chat.open("t1");
    const photo = new File(["png"], "photo.png", { type: "image/png" });
    chat.edit("Привет");
    chat.attach(photo);
    expect(await chat.send()).toBe("unknown");
    const first = chat.attempt!;
    expect(first).toMatchObject({ state: "unknown", text: "Привет", reason: "Нет связи с сервером." });
    expect(chat.sending).toBe(false);

    // The operator fixes the text: the attempt stays as it was sent.
    chat.edit("Привет!");
    chat.attach(null);
    expect(chat.attempt).toMatchObject({ key: first.key, text: "Привет" });
    expect(await chat.send()).toBe("blocked");
    expect(useWorkspaceStore().notice).toBe(SEND_BLOCKED);
    expect(sends(calls)).toHaveLength(1);

    lose = false;
    expect(await chat.retrySend()).toBe("accepted");
    const [lost, again] = sends(calls);
    expect(again!.key).toBe(lost!.key);
    expect([again!.text, (again!.file as File).name]).toEqual(["Привет", "photo.png"]);
    expect(chat.attempt).toBeNull();
    // The edited draft is the operator's next message: it stays.
    expect(chat.draft).toEqual({ text: "Привет!", file: null });
  });

  it("the same text and file again are the same attempt; a server error does not prove nothing was saved", async () => {
    const chat = useChatStore();
    let failing = true;
    const calls = api((path) => {
      if (path !== "tickets/t1/send") return quiet(path);
      return failing ? new Response(JSON.stringify({ detail: "Попробуйте снова" }), { status: 503 }) : { id: "m1" };
    });
    await chat.open("t1");
    chat.edit("Здравствуйте");
    expect(await chat.send()).toBe("unknown");
    expect(chat.attempt?.reason).toBe("Попробуйте снова");
    failing = false;
    expect(await chat.send()).toBe("accepted");
    expect(sends(calls).map((sent) => sent.key)).toEqual([sends(calls)[0]!.key, sends(calls)[0]!.key]);
    expect(chat.draft).toEqual({ text: "", file: null });
  });

  it("an explicit refusal ends the attempt and keeps the draft; the next send is a new attempt", async () => {
    const chat = useChatStore();
    let refuse = true;
    const calls = api((path) => {
      if (path !== "tickets/t1/send") return quiet(path);
      return refuse ? new Response(JSON.stringify({ detail: "Клиент заблокирован." }), { status: 409 }) : { id: "m1" };
    });
    await chat.open("t1");
    chat.edit("Текст");
    expect(await chat.send()).toBe("rejected");
    expect(chat.attempt).toBeNull();
    expect(chat.draft).toEqual({ text: "Текст", file: null });
    expect(useWorkspaceStore().notice).toBe("Клиент заблокирован.");
    refuse = false;
    expect(await chat.send()).toBe("accepted");
    const [refused, accepted] = sends(calls);
    expect(accepted!.key).not.toBe(refused!.key);
  });

  it("a request that hangs past the deadline becomes unknown and frees the reply box", async () => {
    vi.useFakeTimers();
    const chat = useChatStore();
    const calls = api((path, init) => {
      if (path !== "tickets/t1/send") return quiet(path);
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
      });
    });
    await chat.open("t1");
    chat.edit("Долгий ответ");
    const sent = chat.send();
    await vi.advanceTimersByTimeAsync(0);
    expect(chat.sending).toBe(true);
    // A second press while it runs sends nothing.
    expect(await chat.send()).toBe("skipped");
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT);
    expect(await sent).toBe("unknown");
    expect(chat.sending).toBe(false);
    expect(chat.attempt).toMatchObject({ state: "unknown", reason: `Сервер не ответил за ${SEND_TIMEOUT / 1000} с.` });
    expect(sends(calls)).toHaveLength(1);
  });

  it("a retry refused with 4xx keeps the attempt: the request before it may have saved the message", async () => {
    const chat = useChatStore();
    const answers: (() => unknown)[] = [
      () => { throw new TypeError("Failed to fetch"); },
      () => new Response(JSON.stringify({ detail: "Слишком много запросов." }), { status: 429 }),
      () => ({ id: "m1" }),
    ];
    const calls = api((path) => (path === "tickets/t1/send" ? answers.shift()!() : quiet(path)));
    await chat.open("t1");
    chat.edit("Исходный текст");
    expect(await chat.send()).toBe("unknown");
    chat.edit("Исправленный текст");
    expect(await chat.retrySend()).toBe("unknown");
    expect(chat.attempt).toMatchObject({ text: "Исходный текст", reason: "Слишком много запросов.", tries: 2 });
    expect(await chat.retrySend()).toBe("accepted");
    const keys = sends(calls).map((sent) => sent.key);
    expect(keys).toEqual([keys[0], keys[0], keys[0]]);
    expect(sends(calls).map((sent) => sent.text)).toEqual(["Исходный текст", "Исходный текст", "Исходный текст"]);
    expect(chat.draft).toEqual({ text: "Исправленный текст", file: null });
  });

  it("the session ends during a request: its late answer touches nothing of the next session", async () => {
    const chat = useChatStore();
    const session = useSessionStore();
    const pending: ((value: unknown) => void)[] = [];
    api((path) => (path === "tickets/t1/send" ? new Promise((resolve) => pending.push(resolve)) : quiet(path)));
    await chat.open("t1");
    chat.edit("Первая сессия");
    const old = chat.send();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    session.signOut();
    expect(chat.attempts.size).toBe(0);
    expect(chat.sending).toBe(false);
    session.signIn({ account: ACCOUNT, csrf: "c" });
    useProjectsStore().currentId = "p1";
    await chat.open("t1");
    chat.edit("Вторая сессия");
    const fresh = chat.send();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[0]!(new Response(JSON.stringify({ id: "m-old" }), { status: 200 }));
    expect(await old).toBe("skipped");
    // The new session's request still runs.
    expect(chat.sending).toBe(true);
    expect(chat.attempt?.text).toBe("Вторая сессия");
    pending[1]!(new Response(JSON.stringify({ id: "m-new" }), { status: 200 }));
    expect(await fresh).toBe("accepted");
  });

  it("an attempt still waiting for its answer is not settled by the history", async () => {
    const chat = useChatStore();
    let answer!: (value: unknown) => void;
    let key = "";
    api((path, init) => {
      if (path === "tickets/t1/send") {
        key = (init.headers as Record<string, string>)["X-Idempotency-Key"]!;
        return new Promise((resolve) => { answer = resolve; });
      }
      return path.endsWith("/sync") && key ? page([message("m1", 5, { direction: "operator_to_user", command: key })]) : quiet(path);
    });
    await chat.open("t1");
    chat.edit("Ответ");
    const sent = chat.send();
    await vi.waitFor(() => expect(key).not.toBe(""));
    await chat.syncMessages();
    expect(chat.attempt?.state).toBe("sending");
    expect(useWorkspaceStore().notice).not.toBe(SEND_FOUND);
    answer(new Response(JSON.stringify({ id: "m1" }), { status: 200 }));
    expect(await sent).toBe("accepted");
    expect(chat.attempt).toBeNull();
  });

  it("the deadline of a file grows with its upload", async () => {
    vi.useFakeTimers();
    const megabyte = new File([new Uint8Array(1024 * 1024)], "scan.pdf", { type: "application/pdf" });
    expect(sendDeadline(null)).toBe(SEND_TIMEOUT);
    expect(sendDeadline(megabyte)).toBe(SEND_TIMEOUT + (1024 * 1024 / UPLOAD_RATE) * 1000);
    const chat = useChatStore();
    api((path, init) => {
      if (path !== "tickets/t1/send") return quiet(path);
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
      });
    });
    await chat.open("t1");
    chat.attach(megabyte);
    const sent = chat.send();
    await vi.advanceTimersByTimeAsync(sendDeadline(megabyte) - 1000);
    expect(chat.sending).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await sent).toBe("unknown");
    expect(chat.attempt?.reason).toBe(`Сервер не ответил за ${sendDeadline(megabyte) / 1000} с.`);
  });

  it("a saved message whose history then fails to load is still sent", async () => {
    const chat = useChatStore();
    let broken = false;
    api((path) => {
      if (path === "tickets/t1/send") {
        broken = true;
        return { id: "m1" };
      }
      if (broken && path.endsWith("/sync")) throw new TypeError("Failed to fetch");
      return quiet(path);
    });
    await chat.open("t1");
    chat.edit("Готово");
    expect(await chat.send()).toBe("accepted");
    expect(chat.attempt).toBeNull();
    expect(chat.draft).toEqual({ text: "", file: null });
    expect(useWorkspaceStore().notice).toBe(`${SEND_REFRESH_FAILED}: Нет связи с сервером.`);
  });

  it("an attempt with an unknown outcome ends when the history shows its message", async () => {
    const chat = useChatStore();
    let saved: string | null = null;
    api((path, init) => {
      if (path === "tickets/t1/send") {
        saved = (init.headers as Record<string, string>)["X-Idempotency-Key"]!;
        throw new TypeError("Failed to fetch");
      }
      if (path.endsWith("/sync")) {
        return page(saved ? [message("m1", 5, { direction: "operator_to_user", text: "Ответ", command: saved })] : []);
      }
      return quiet(path);
    });
    await chat.open("t1");
    chat.edit("Ответ");
    expect(await chat.send()).toBe("unknown");
    await chat.syncMessages();
    expect(chat.attempt).toBeNull();
    expect(chat.draft).toEqual({ text: "", file: null });
    expect(useWorkspaceStore().notice).toBe(SEND_FOUND);
  });

  it("attempts belong to their dialogue, outlive a project switch and end with the session", async () => {
    const chat = useChatStore();
    api((path) => {
      if (path === "tickets/t1/send") throw new TypeError("Failed to fetch");
      return path.endsWith("/sync") ? page([]) : path === "tickets/sync" ? { order: [], items: [] } : detail(path.split("/")[1]!);
    });
    await chat.open("t1");
    chat.edit("Для Анны");
    expect(await chat.send()).toBe("unknown");
    const key = chat.attempt!.key;
    await chat.open("t2");
    expect(chat.attempt).toBeNull();
    chat.edit("Для Бориса");
    await chat.open("t1");
    expect(chat.attempt?.key).toBe(key);
    // Another project: the dialogue state goes, the attempt stays for the way back.
    chat.reset();
    expect(chat.attempts.get("p1/t1")?.key).toBe(key);
    useSessionStore().signOut();
    expect(chat.attempts.size).toBe(0);
  });

  it("refuses a file over 20 MiB and keeps the draft", async () => {
    const chat = useChatStore();
    api(quiet);
    await chat.open("t1");
    chat.edit("Текст");
    expect(chat.attach(new File([new Uint8Array(MAX_FILE_BYTES + 1)], "big.bin"))).toBe(false);
    expect(useWorkspaceStore().notice).toBe(FILE_TOO_LARGE);
    expect(chat.draft).toEqual({ text: "Текст", file: null });
  });

  it("warns when a send's outcome is unknown", async () => {
    const chat = useChatStore();
    api((path) => (path.endsWith("/sync") ? page([message("a", 1, { uncertain: true })]) : detail("t1")));
    await chat.open("t1");
    expect(useWorkspaceStore().notice).toBe(UNCERTAIN);
  });

  it("marks read once per last message", async () => {
    const chat = useChatStore();
    const calls = api((path) => (path.includes("/read/") ? { ok: true } : path.endsWith("/sync") ? page([message("a", 1)]) : detail("t1")));
    await chat.open("t1");
    chat.markRead("a");
    chat.markRead("a");
    await vi.waitFor(() => expect(calls.filter((call) => call.path === "tickets/t1/read/a")).toHaveLength(1));
  });
});
