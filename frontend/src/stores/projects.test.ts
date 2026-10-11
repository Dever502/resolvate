import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../api/types";
import { useChatStore } from "./chat";
import { useFoldersStore } from "./folders";
import { useProjectsStore } from "./projects";
import { useSessionStore } from "./session";
import { useTicketsStore } from "./tickets";
import { NO_LINK_ACCESS, useWorkspaceStore } from "./workspace";

const ACCOUNT = { id: "a1", login: "operator", name: "Оператор", role: "operator" as const, active: true, telegram_id: null };
const project = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: id, active: true, admin_id: "a0", role: "operator", logo: null, ...extra });

function api(projects: () => Project[]): string[] {
  const paths: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    paths.push(url);
    const body = url === "/console/projects" ? projects()
      : url.endsWith("/folders") ? []
      : url.endsWith("/tickets/sync") ? { order: [], items: [] }
      : url.endsWith("/sync") ? { order: [], items: [], removed: [], reset: false, before: null, has_older: false }
      : { id: "t1", display_name: "Клиент", status: "open", channel: "telegram", folder_id: null, folder_revision: 0 };
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  return paths;
}

describe("projects and the start of the workspace", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useSessionStore().signIn({ account: ACCOUNT, csrf: "c" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    history.replaceState(null, "", "/console/");
  });

  it("opens the first project the account may work in: a member's, active", async () => {
    api(() => [project("p0", { role: null }), project("p1", { active: false }), project("p2"), project("p3")]);
    await useProjectsStore().refresh(true);
    expect(useProjectsStore().available.map((item) => item.id)).toEqual(["p2", "p3"]);
    expect(useProjectsStore().currentId).toBe("p2");
  });

  it("deselects a project that became unavailable, without a notice", async () => {
    let list = [project("p1"), project("p2")];
    api(() => list);
    const projects = useProjectsStore();
    await projects.refresh(true);
    list = [project("p2")];
    await projects.refresh(false);
    expect(projects.currentId).toBeNull();
    expect(useWorkspaceStore().notice).toBe("");
  });

  it("refuses to switch while a message is being sent, and otherwise drops the old project's data", () => {
    const projects = useProjectsStore();
    const chat = useChatStore();
    projects.currentId = "p1";
    useTicketsStore().setQuery("text");
    useFoldersStore().folders = [{ id: "f1", name: "VIP", revision: 0 }];
    chat.sending = true;
    expect(projects.select("p2")).toBe(false);
    expect(projects.currentId).toBe("p1");
    chat.sending = false;
    expect(projects.select("p2")).toBe(true);
    expect([projects.currentId, useTicketsStore().query, useFoldersStore().folders.length]).toEqual(["p2", "", 0]);
  });

  it("follows a ?project=&ticket= link after sign-in, or says the project is not available", async () => {
    api(() => [project("p1"), project("p2")]);
    history.replaceState(null, "", "/console/?project=p2&ticket=t1");
    await useWorkspaceStore().enter();
    expect([useProjectsStore().currentId, useChatStore().ticketId]).toEqual(["p2", "t1"]);

    setActivePinia(createPinia());
    useSessionStore().signIn({ account: ACCOUNT, csrf: "c" });
    history.replaceState(null, "", "/console/?project=p9&ticket=t1");
    await useWorkspaceStore().enter();
    expect(useWorkspaceStore().notice).toBe(NO_LINK_ACCESS);
    expect(useChatStore().ticketId).toBeNull();
  });

  it("forgets everything when the session ends", async () => {
    api(() => [project("p1")]);
    await useProjectsStore().refresh(true);
    useWorkspaceStore().show("Сообщение");
    useSessionStore().signOut();
    expect([useProjectsStore().all, useProjectsStore().currentId, useWorkspaceStore().notice]).toEqual([[], null, ""]);
  });
});

describe("project administration", () => {
  const OWNER = { id: "a0", login: "admin", name: "Админ", role: "admin" as const, active: true, telegram_id: null };
  beforeEach(() => {
    setActivePinia(createPinia());
    useSessionStore().signIn({ account: OWNER, csrf: "c" });
  });
  afterEach(() => vi.unstubAllGlobals());

  function server(list: () => Project[], answer: (url: string) => [number, unknown] = () => [200, { ok: true }]) {
    const calls: { method: string; url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const [status, body] = method === "GET" && url === "/console/projects" ? [200, list()] : answer(url);
      return new Response(JSON.stringify(body), { status });
    }));
    return calls;
  }

  it("reports a failed first load as an error, never as an empty list, until a load succeeds", async () => {
    let failing = true;
    vi.stubGlobal("fetch", vi.fn(async () => failing
      ? new Response(JSON.stringify({ detail: "Сервер недоступен." }), { status: 500 })
      : new Response("[]", { status: 200 })));
    const projects = useProjectsStore();
    await expect(projects.refresh(false)).rejects.toThrow("Сервер недоступен.");
    expect([projects.loaded, projects.error]).toEqual([false, "Сервер недоступен."]);
    failing = false;
    await projects.refresh(false);
    expect([projects.loaded, projects.error, projects.all]).toEqual([true, "", []]);
  });

  it("sends each change to its route and reloads the list, so the project menu and logos follow", async () => {
    let list = [project("p1", { role: "admin", admin_id: "a0" })];
    const calls = server(() => list, (url) => (url === "/console/projects" ? [200, { id: "p2" }] : [200, { ok: true }]));
    const projects = useProjectsStore();
    list = [...list, project("p2", { role: "admin", admin_id: "a0", active: false })];
    expect(await projects.create("Новый", "admin")).toBe("p2");
    expect(projects.all.map((item) => item.id)).toEqual(["p1", "p2"]);
    await projects.setActive("p2", true);
    await projects.grant("p2", "pavel");
    await projects.revoke("p2", "pavel");
    await projects.transfer("p2", "irina");
    expect(calls.filter((call) => call.method === "POST").map((call) => [call.url, call.body])).toEqual([
      ["/console/projects", { name: "Новый", admin_login: "admin" }],
      ["/console/projects/p2/active", { active: true }],
      ["/console/projects/p2/members", { login: "pavel" }],
      ["/console/projects/p2/members/remove", { login: "pavel" }],
      ["/console/projects/p2/admin", { login: "irina" }],
    ]);
    // Every change is followed by a reload of the list.
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(5);
  });

  it("passes the server's refusal on, and does not report a done change as failed when only the reload fails", async () => {
    server(() => [], (url) => (url.endsWith("/active")
      ? [409, { detail: "Администратор проекта должен сначала настроить бота и группу." }]
      : [200, { ok: true }]));
    const projects = useProjectsStore();
    await expect(projects.setActive("p1", true)).rejects.toThrow("Администратор проекта должен сначала настроить бота и группу.");

    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => (init.method === "POST"
      ? new Response('{"ok":true}', { status: 200 })
      : new Response(JSON.stringify({ detail: url }), { status: 502 }))));
    await expect(projects.grant("p1", "admin")).resolves.toBeUndefined();
  });
});
