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
