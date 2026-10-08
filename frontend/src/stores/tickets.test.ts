import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TicketItem } from "../api/types";
import { FOLDER_GONE, useFoldersStore } from "./folders";
import { useProjectsStore } from "./projects";
import { useSessionStore } from "./session";
import { PAGE_SIZE, useTicketsStore } from "./tickets";
import { useWorkspaceStore } from "./workspace";

const ACCOUNT = { id: "a1", login: "operator", name: "Оператор", role: "operator" as const, active: true, telegram_id: null };
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

function row(id: string, revision = `${id}-1`): TicketItem {
  return { id, name: id, channel: "telegram", status: "open", time: "2026-10-07T10:00:00Z", preview: "", unread: 0, folder_id: null, folder_revision: 0, revision };
}

interface Call { path: string; body: Record<string, unknown> }

/** Routes console requests to handlers by path; records what was asked. */
function api(handlers: Record<string, (body: Record<string, unknown>) => unknown>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const path = url.replace(/^\/console\/projects\/p1\//, "");
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ path, body });
    const handler = handlers[path];
    if (!handler) throw new Error(`unexpected ${path}`);
    return json(await handler(body));
  }));
  return calls;
}

describe("tickets store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useSessionStore().signIn({ account: ACCOUNT, csrf: "c" });
    useProjectsStore().currentId = "p1";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("asks only for changed rows, keeps the known ones and drops those no longer listed", async () => {
    const tickets = useTicketsStore();
    let answer = { order: ["t1", "t2"], items: [row("t1"), row("t2")] };
    const calls = api({ folders: () => [], "tickets/sync": () => answer });
    await tickets.sync();
    expect(tickets.rows.map((item) => item.id)).toEqual(["t1", "t2"]);

    answer = { order: ["t2", "t3"], items: [row("t3")] };
    await tickets.sync();
    expect(calls.at(-1)!.body.known).toEqual({ t1: "t1-1", t2: "t2-1" });
    expect(tickets.rows.map((item) => item.id)).toEqual(["t2", "t3"]);
    expect(tickets.items.has("t1")).toBe(false);
  });

  it("requests every shown page and shows the next-page button only after a full page", async () => {
    const tickets = useTicketsStore();
    const full = Array.from({ length: PAGE_SIZE }, (_, index) => `t${index}`);
    const calls = api({
      folders: () => [],
      "tickets/sync": (body) => (body.offset === 0
        ? { order: full, items: full.map((id) => row(id)) }
        : { order: ["last"], items: [row("last")] }),
    });
    await tickets.sync();
    expect(tickets.hasMore).toBe(true);
    tickets.more();
    await tickets.sync();
    expect(calls.filter((call) => call.path === "tickets/sync").map((call) => call.body.offset)).toEqual([0, 0, 50]);
    expect(tickets.rows).toHaveLength(PAGE_SIZE + 1);
    expect(tickets.hasMore).toBe(false);
  });

  it("discards an answer for filters that changed while it was on its way", async () => {
    const tickets = useTicketsStore();
    let release!: () => void;
    api({
      folders: () => [],
      "tickets/sync": (body) => (body.query === "old"
        ? new Promise((resolve) => { release = () => resolve({ order: ["stale"], items: [row("stale")] }); })
        : { order: ["fresh"], items: [row("fresh")] }),
    });
    tickets.setQuery("old");
    const first = tickets.sync();
    await vi.waitFor(() => expect(release).toBeDefined());
    tickets.setQuery("new");
    await tickets.sync();
    release();
    await first;
    expect(tickets.rows.map((item) => item.id)).toEqual(["fresh"]);
  });

  it("drops a filter on a folder another operator deleted and says so", async () => {
    const tickets = useTicketsStore();
    const calls = api({ folders: () => [{ id: "f2", name: "Другая", revision: 0 }], "tickets/sync": () => ({ order: [], items: [] }) });
    tickets.setFolder("f1");
    await tickets.sync();
    expect(tickets.folderFilter).toBe("");
    expect(calls.at(-1)!.body.folder_id).toBeNull();
    expect(useWorkspaceStore().notice).toBe(FOLDER_GONE);
    expect(useFoldersStore().folders.map((folder) => folder.id)).toEqual(["f2"]);
  });

  it("starts over for another project but keeps the archive mode, as the classic console did", () => {
    const tickets = useTicketsStore();
    tickets.setQuery("text");
    tickets.setArchived(true);
    tickets.setFolder("f1");
    tickets.reset();
    expect([tickets.query, tickets.folderFilter, tickets.archived]).toEqual(["", "", true]);
  });
});
