import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, MessagePage, TicketDetail } from "../api/types";
import { CACHE_AGE, FILE_TOO_LARGE, MAX_FILE_BYTES, UNCERTAIN, useChatStore } from "./chat";
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

  it("keeps a draft per dialogue; any edit or new file drops the send key, a failed send keeps it", async () => {
    const chat = useChatStore();
    let failing = true;
    const calls = api((path) => {
      if (path === "tickets/t1/send") {
        return failing ? new Response(JSON.stringify({ detail: "Нет связи." }), { status: 503 }) : { id: "sent" };
      }
      return path.endsWith("/sync") ? page([]) : path === "tickets/sync" ? { order: [], items: [] } : path === "folders" ? [] : detail("t1");
    });
    await chat.open("t1");
    const keys = (): string[] => calls.filter((call) => call.path === "tickets/t1/send")
      .map((call) => (call.init.headers as Record<string, string>)["X-Idempotency-Key"]!);
    chat.edit("Привет");
    await chat.send();
    expect(chat.draft?.text).toBe("Привет");
    expect(chat.draft?.key).toBe(keys()[0]);
    await chat.send();
    expect(keys()[1]).toBe(keys()[0]);
    chat.edit("Привет!");
    expect(chat.draft?.key).toBeNull();
    failing = false;
    await chat.send();
    expect(keys()[2]).not.toBe(keys()[0]);
    expect(chat.draft).toEqual({ text: "", file: null, key: null });
    expect(chat.attach(new File([new Uint8Array(MAX_FILE_BYTES + 1)], "big.bin"))).toBe(false);
    expect(useWorkspaceStore().notice).toBe(FILE_TOO_LARGE);
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
