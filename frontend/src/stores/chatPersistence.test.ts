import { IDBFactory, IDBKeyRange as FakeKeyRange } from "fake-indexeddb";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagePage, TicketDetail } from "../api/types";
import { keepUnsaved } from "../lib/navigation";
import * as workStore from "../lib/workStore";
import { closeWork, createAttempt, readAttempt, readDraft, writeDraft, type WorkScope } from "../lib/workStore";
import { ATTEMPT_ELSEWHERE, ATTEMPT_RELOADED, DRAFT_CONFLICT, STORAGE_OFF, useChatStore } from "./chat";
import { useProjectsStore } from "./projects";
import { useSessionStore } from "./session";
import { useWorkspaceStore } from "./workspace";

// Drafts and send attempts kept in the browser's storage (lib/workStore.ts over fake-indexeddb). A
// "reload" is a fresh Pinia over the same database. The real engines: e2e/persistence.spec.ts.
const operator = (id: string) => ({ id, login: id, name: id, role: "operator" as const, active: true, telegram_id: null });
const anna: WorkScope = { account: "a1", project: "p1", ticket: "t1" };
const detail = (id: string): TicketDetail => ({
  id, display_name: id, username: null, channel: "telegram", status: "open", email: null, identity_value: null,
  remnawave_user_uuid: null, created_at: "2026-10-01T00:00:00Z", folder_id: null, folder_revision: 0,
});
const empty: MessagePage = { order: [], items: [], removed: [], reset: false, before: null, has_older: false };

interface Sent { key: string; text: string; file: string | null }
/** The project API: detail, history and lists answer; `send` decides the send requests. */
function serve(send: (sent: Sent) => Promise<Response> | Response = () => new Response(JSON.stringify({ id: "m1" }))): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const path = url.replace(/^\/console\/projects\/p\d\//, "");
    if (path.endsWith("/send")) {
      const form = init.body as FormData;
      const file = form.get("file");
      const request = {
        key: (init.headers as Record<string, string>)["X-Idempotency-Key"]!, text: String(form.get("text")),
        file: file instanceof File ? file.name : null,
      };
      sent.push(request);
      return send(request);
    }
    const body = path.endsWith("/sync") ? empty : path === "tickets/sync" ? { order: [], items: [] } : detail(path.split("/")[1] ?? "t1");
    return new Response(JSON.stringify(body));
  }));
  return sent;
}

/** A fresh console over the same browser storage, signed in as `account`. */
function start(account = "a1"): ReturnType<typeof useChatStore> {
  setActivePinia(createPinia());
  useSessionStore().signIn({ account: operator(account), csrf: "c" });
  useProjectsStore().currentId = "p1";
  return useChatStore();
}

async function openReady(chat: ReturnType<typeof useChatStore>, id = "t1"): Promise<void> {
  await chat.open(id);
  await vi.waitFor(() => expect(chat.draft).not.toBeNull());
}

describe("persistent drafts and send attempts", () => {
  // Only setTimeout is faked: the delayed draft writes of one test never fire into the next one.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", FakeKeyRange);
  });
  afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    await closeWork();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it.each(["success", "existing", "failure", "timeout"])("a storage %s after an account switch never sends or changes the new session", async (outcome) => {
    const sent = serve();
    const chat = start();
    await openReady(chat);
    chat.edit("Private reply from the previous account");
    let resolve!: (value: { existing: workStore.StoredAttempt | null }) => void;
    let reject!: (error: Error) => void;
    vi.spyOn(workStore, "createAttempt").mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
    const sending = chat.send();
    expect(chat.sending).toBe(true);
    const session = useSessionStore();
    session.signOut();
    session.signIn({ account: operator("a2"), csrf: "new-csrf" });
    useProjectsStore().currentId = "p1";
    await openReady(chat);
    chat.edit("New account's draft");
    useWorkspaceStore().show("New session notice");
    if (outcome === "failure") reject(new Error("storage failed"));
    else if (outcome === "timeout") await vi.advanceTimersByTimeAsync(workStore.STORAGE_PATIENCE);
    else resolve({ existing: outcome === "existing" ? {
      v: 1, ...anna, key: "old-attempt", text: "Old reply", file: null,
      state: "unknown", reason: "offline", tries: 1, createdAt: Date.now(),
    } : null });
    expect(await sending).toBe("skipped");
    expect(sent).toEqual([]);
    expect(chat.draft?.text).toBe("New account's draft");
    expect(chat.attempt).toBeNull();
    expect(chat.sending).toBe(false);
    expect(useWorkspaceStore().notice).toBe("New session notice");
    // A still later storage completion also cannot adopt anything into the new account.
    if (outcome === "timeout") resolve({ existing: null });
    await chat.flushDrafts();
  });

  it.each([false, true])("different file bytes with identical metadata stay a new draft (reload: %s)", async (reload) => {
    let fail = true;
    const sent = serve(() => {
      if (fail) throw new TypeError("offline");
      return new Response(JSON.stringify({ id: "m1" }));
    });
    let chat = start();
    await openReady(chat);
    chat.edit("Same caption");
    chat.attach(new File(["AAAA"], "same.png", { type: "image/png", lastModified: 1000 }));
    await chat.flushDrafts();
    expect(await chat.send()).toBe("unknown");
    chat.attach(new File(["BBBB"], "same.png", { type: "image/png", lastModified: 1000 }));
    await chat.flushDrafts();
    if (reload) {
      chat = start();
      await openReady(chat);
    }
    expect(await chat.send()).toBe("blocked");
    expect(sent).toHaveLength(1);
    fail = false;
    expect(await chat.retrySend()).toBe("accepted");
    expect(sent[1]?.key).toBe(sent[0]?.key);
    expect(await chat.draft?.file?.text()).toBe("BBBB");
    expect(await (await readDraft(anna))?.file?.text()).toBe("BBBB");
  });

  it.each([false, true])("file comparison stays single-flight and cannot clear a new session (switch: %s)", async (switchAccount) => {
    const sent = serve();
    const chat = start();
    await openReady(chat);
    chat.edit("Original reply");
    let finish!: (equal: boolean) => void;
    vi.spyOn(workStore, "sameFile").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const sending = chat.send();
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(chat.sending).toBe(true);
    expect(await chat.send()).toBe("skipped");
    expect(sent).toHaveLength(1);
    if (switchAccount) {
      const session = useSessionStore();
      session.signOut();
      session.signIn({ account: operator("a2"), csrf: "new-csrf" });
      useProjectsStore().currentId = "p1";
      await openReady(chat);
      chat.edit("New account's draft");
    }
    finish(true);
    expect(await sending).toBe(switchAccount ? "skipped" : "accepted");
    expect(chat.draft?.text).toBe(switchAccount ? "New account's draft" : "");
    await chat.flushDrafts();
  });

  it("a timed-out storage write finishing after sign-out never updates work under the new account", async () => {
    serve(() => { throw new TypeError("offline"); });
    const chat = start();
    await openReady(chat);
    chat.edit("Old reply");
    let finish!: (value: { existing: null }) => void;
    vi.spyOn(workStore, "createAttempt").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const update = vi.spyOn(workStore, "updateAttempt");
    const remove = vi.spyOn(workStore, "removeAttempt");
    const sending = chat.send();
    await vi.advanceTimersByTimeAsync(workStore.STORAGE_PATIENCE);
    expect(await sending).toBe("unknown");
    const session = useSessionStore();
    session.signOut();
    session.signIn({ account: operator("a2"), csrf: "new-csrf" });
    finish({ existing: null });
    await Promise.resolve();
    expect(update).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    await chat.flushDrafts();
  });

  it("a draft survives a reload; of fast edits the last one is kept", async () => {
    serve();
    let chat = start();
    await openReady(chat);
    for (const text of ["П", "Пр", "При", "Прив", "Привет"]) chat.edit(text);
    chat.flushDrafts();
    await vi.waitFor(async () => expect((await readDraft(anna))?.text).toBe("Привет"));
    chat = start();
    await openReady(chat);
    expect(chat.draft).toEqual({ text: "Привет", file: null });
  });

  it("leaving the page keeps in the tab the texts whose writes have not landed", async () => {
    serve();
    const chat = start();
    await openReady(chat);
    chat.edit("Ещё не записано");
    window.dispatchEvent(new Event("pagehide"));
    expect(JSON.parse(sessionStorage.getItem("resolvate.unsaved")!)).toEqual({
      v: 1, texts: [{ ...anna, text: "Ещё не записано", at: expect.any(Number) }],
    });
    // The write the page started meanwhile lands here (in WebKit it would not): nothing is left over.
    await vi.waitFor(async () => expect((await readDraft(anna))?.text).toBe("Ещё не записано"));
    window.dispatchEvent(new Event("pagehide"));
    expect(sessionStorage.getItem("resolvate.unsaved")).toBeNull();
  });

  it("texts the page was left with come back after a reload, unless a newer draft is stored", async () => {
    serve();
    await writeDraft({ v: 1, ...anna, text: "Старый текст", file: null, lostFile: null, rev: "r1", tab: "old-tab", updatedAt: 1_000 }, null, null);
    await writeDraft({ v: 1, ...anna, ticket: "t2", text: "Новее в другой вкладке", file: null, lostFile: null, rev: "r2", tab: "other-tab", updatedAt: 5_000 }, null, null);
    keepUnsaved([
      { ...anna, text: "Набрано перед обновлением", at: 2_000 },
      { ...anna, ticket: "t2", text: "Старее", at: 3_000 },
      { ...anna, account: "a2", text: "Другого оператора", at: 9_000 },
    ]);
    const chat = start();
    await openReady(chat);
    expect(chat.draft?.text).toBe("Набрано перед обновлением");
    await openReady(chat, "t2");
    expect(chat.draft?.text).toBe("Новее в другой вкладке");
    expect(sessionStorage.getItem("resolvate.unsaved")).toBeNull();
    expect(await readDraft({ ...anna, account: "a2" })).toBeNull();
  });

  it("stores the attempt before its request leaves; a reload while it runs restores it as unknown, without a send", async () => {
    const seen: (string | undefined)[] = [];
    const sent = serve(async (request) => {
      seen.push((await readAttempt(anna))?.key);
      return new Promise<Response>(() => undefined);
    });
    let chat = start();
    await openReady(chat);
    chat.edit("Ответ клиенту");
    void chat.send();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    // The key was in the storage when the request left.
    expect(seen[0]).toBe(sent[0]!.key);

    chat = start();
    await openReady(chat);
    expect(chat.attempt).toMatchObject({ key: sent[0]!.key, text: "Ответ клиенту", state: "unknown", reason: ATTEMPT_RELOADED, persisted: true });
    expect(sent).toHaveLength(1);
  });

  it("a retry after a reload keeps the key and the text; the accepted send leaves nothing behind", async () => {
    let answer: () => Promise<Response> | Response = () => new Promise<Response>(() => undefined);
    const sent = serve(() => answer());
    let chat = start();
    await openReady(chat);
    chat.edit("Исходный текст");
    void chat.send();
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    answer = () => new Response(JSON.stringify({ id: "m1" }));
    chat = start();
    await openReady(chat);
    chat.edit("Исправленный текст");
    expect(await chat.retrySend()).toBe("accepted");
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[1]!.text).toBe("Исходный текст");
    expect(chat.draft).toEqual({ text: "Исправленный текст", file: null });
    chat.flushDrafts();
    await vi.waitFor(async () => expect(await readAttempt(anna)).toBeNull());
    expect((await readDraft(anna))?.text).toBe("Исправленный текст");
  });

  it("a sent draft does not come back: its waiting write is dropped with it", async () => {
    serve();
    let chat = start();
    await openReady(chat);
    chat.edit("Отправлено");
    expect(await chat.send()).toBe("accepted");
    // The delayed write of "Отправлено" would fire by now.
    vi.advanceTimersByTime(1000);
    await vi.waitFor(async () => expect(await readDraft(anna)).toBeNull());
    expect(await readAttempt(anna)).toBeNull();
    chat = start();
    await openReady(chat);
    expect(chat.draft).toEqual({ text: "", file: null });
  });

  it("without storage the send still goes, and says it would not survive a reload", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await closeWork();
    const sent = serve(() => { throw new TypeError("Failed to fetch"); });
    const chat = start();
    await openReady(chat);
    chat.edit("Без хранилища");
    expect(await chat.send()).toBe("unknown");
    expect(sent).toHaveLength(1);
    expect(chat.attempt?.persisted).toBe(false);
    expect(useWorkspaceStore().notice).toBe(STORAGE_OFF);
  });

  it("another tab's attempt in this dialogue is taken over instead of a second send", async () => {
    const sent = serve();
    const chat = start();
    await openReady(chat);
    await createAttempt({
      v: 1, ...anna, key: "other-tab", text: "Из другой вкладки", file: null, state: "unknown", reason: "Нет связи с сервером.", tries: 1, createdAt: Date.now(),
    });
    chat.edit("Из этой вкладки");
    expect(await chat.send()).toBe("blocked");
    expect(sent).toHaveLength(0);
    expect(chat.attempt).toMatchObject({ key: "other-tab", text: "Из другой вкладки", state: "unknown" });
    expect(useWorkspaceStore().notice).toBe(ATTEMPT_ELSEWHERE);
  });

  it("switching projects keeps the drafts; another account never sees them, the same one does", async () => {
    serve();
    let chat = start();
    await openReady(chat);
    chat.edit("Для Анны");
    useProjectsStore().select("p2");
    useProjectsStore().select("p1");
    await openReady(chat);
    expect(chat.draft?.text).toBe("Для Анны");

    useSessionStore().signOut();
    chat = start("a2");
    await openReady(chat);
    expect(chat.draft).toEqual({ text: "", file: null });
    chat = start("a1");
    await openReady(chat);
    expect(chat.draft?.text).toBe("Для Анны");
  });

  it("a draft with a file, sent again after a reload, keeps its key and is gone once accepted", async () => {
    let answer: () => Promise<Response> | Response = () => new Promise<Response>(() => undefined);
    const sent = serve(() => answer());
    let chat = start();
    await openReady(chat);
    chat.edit("Фото договора");
    chat.attach(new File(["png bytes"], "contract.png", { type: "image/png", lastModified: 1000 }));
    void chat.send();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    chat.flushDrafts();
    await vi.waitFor(async () => expect((await readDraft(anna))?.file?.name).toBe("contract.png"));

    answer = () => new Response(JSON.stringify({ id: "m1" }));
    chat = start();
    await openReady(chat);
    expect(chat.attempt).toMatchObject({ text: "Фото договора", state: "unknown" });
    // Enter on the unchanged draft sends the attempt again: the file read back is the same file.
    expect(await chat.send()).toBe("accepted");
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[1]!.file).toBe("contract.png");
    expect(chat.draft).toEqual({ text: "", file: null });
    await vi.waitFor(async () => expect(await readDraft(anna)).toBeNull());
    expect(await readAttempt(anna)).toBeNull();
  });

  it("an attempt read back before its first try was counted is never taken as refused", async () => {
    const sent = serve(() => new Response(JSON.stringify({ detail: "Слишком много запросов." }), { status: 429 }));
    // Stored before the first request; the page went away before the try was written.
    await createAttempt({
      v: 1, ...anna, key: "k-reloaded", text: "Ушло ли?", file: null, state: "sending", reason: "", tries: 0, createdAt: Date.now(),
    });
    const chat = start();
    await openReady(chat);
    expect(await chat.retrySend()).toBe("unknown");
    expect(sent).toHaveLength(1);
    expect(chat.attempt).toMatchObject({ key: "k-reloaded", state: "unknown", tries: 2 });
    expect(await readAttempt(anna)).toMatchObject({ key: "k-reloaded", state: "unknown" });
  });

  it("a send does not remove another tab's draft written meanwhile", async () => {
    serve();
    const chat = start();
    await openReady(chat);
    await writeDraft({ v: 1, ...anna, text: "Черновик другой вкладки", file: null, lostFile: null, rev: "theirs", tab: "other-tab", updatedAt: Date.now() }, null, null);
    chat.edit("Мой ответ");
    expect(await chat.send()).toBe("accepted");
    await chat.flushDrafts();
    expect((await readDraft(anna))?.text).toBe("Черновик другой вкладки");
  });

  it("a storage that never answers leaves the reply box usable and the send unsaved", async () => {
    vi.stubGlobal("indexedDB", { open: () => ({}) });
    await closeWork();
    const sent = serve(() => { throw new TypeError("Failed to fetch"); });
    const chat = start();
    void chat.open("t1");
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(chat.draft).toEqual({ text: "", file: null }));
    expect(useWorkspaceStore().notice).toBe("Хранилище браузера не отвечает. Черновики и отправки после обновления страницы могут пропасть.");
    chat.edit("Без ответа хранилища");
    const sending = chat.send();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await sending).toBe("unknown");
    expect(sent).toHaveLength(1);
    expect(chat.attempt?.persisted).toBe(false);
  });

  it("says so when another tab changed the same draft meanwhile", async () => {
    serve();
    const chat = start();
    await openReady(chat);
    chat.edit("Моя версия");
    chat.flushDrafts();
    await vi.waitFor(async () => expect((await readDraft(anna))?.text).toBe("Моя версия"));
    await writeDraft({ v: 1, ...anna, text: "Версия другой вкладки", file: null, lostFile: null, rev: "theirs", tab: "other-tab", updatedAt: Date.now() }, null, null);
    chat.edit("Моя новая версия");
    chat.flushDrafts();
    await vi.waitFor(() => expect(useWorkspaceStore().notice).toBe(DRAFT_CONFLICT));
    expect((await readDraft(anna))?.text).toBe("Моя новая версия");
  });
});
