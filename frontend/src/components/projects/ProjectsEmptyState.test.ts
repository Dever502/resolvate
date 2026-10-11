import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it } from "vitest";
import type { Account, Project } from "../../api/types";
import { useProjectsStore } from "../../stores/projects";
import { useSessionStore } from "../../stores/session";
import { useWorkspaceStore } from "../../stores/workspace";
import ProjectsEmptyState from "./ProjectsEmptyState.vue";

const OWNER: Account = { id: "a0", login: "admin", name: "Админ", role: "admin", active: true, telegram_id: null };
const OPERATOR: Account = { ...OWNER, id: "a1", login: "operator", role: "operator" };
const project = (id: string, extra: Partial<Project> = {}): Project =>
  ({ id, name: `Проект ${id}`, active: true, admin_id: "a0", role: "operator", logo: null, ...extra });

/** The empty state for an account and a project list; `null` stands for a list not received yet. */
function render(account: Account, list: Project[] | null, error = "") {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSessionStore().signIn({ account, csrf: "c" });
  const projects = useProjectsStore();
  if (list) {
    projects.all = list;
    projects.loaded = true;
  } else projects.error = error;
  const wrapper = mount(ProjectsEmptyState, { global: { plugins: [pinia] } });
  return {
    title: wrapper.get("h2").text(),
    text: wrapper.find("p").exists() ? wrapper.get("p").text() : "",
    action: wrapper.find("button").exists() ? wrapper.get("button") : null,
  };
}

describe("why there is no project, and the next step", () => {
  it("waits for the list, and reports a failed list with a retry instead of an empty installation", () => {
    expect(render(OWNER, null)).toMatchObject({ title: "Загружаем проекты…", action: null });
    const failed = render(OWNER, null, "Сервер недоступен.");
    expect([failed.title, failed.text, failed.action?.text()]).toEqual(["Не удалось загрузить проекты", "Сервер недоступен.", "Повторить"]);
  });

  it("first launch: the installation administrator is offered to create a project, an operator is sent to an administrator", async () => {
    const owner = render(OWNER, []);
    expect([owner.title, owner.action?.text()]).toEqual(["Создайте первый проект", "Создать проект"]);
    await owner.action!.trigger("click");
    expect(useWorkspaceStore().admin).toEqual({ window: "projects", project: null, tab: "members", create: true });
    const operator = render(OPERATOR, []);
    expect([operator.title, operator.action]).toEqual(["Нет доступа к проектам", null]);
    expect(operator.text).toContain("Обратитесь к администратору установки или проекта.");
  });

  it("projects without membership: the installation administrator is sent to grant access", async () => {
    const state = render(OWNER, [project("p1", { role: null, admin_id: "a2" })]);
    expect([state.title, state.action?.text()]).toEqual(["Нет доступа к переписке", "Открыть проекты"]);
    await state.action!.trigger("click");
    expect(useWorkspaceStore().admin).toMatchObject({ window: "projects", project: null, create: false });
  });

  it("switched-off projects: enable (installation administrator), configure (project administrator) or wait (operator)", async () => {
    expect(render(OWNER, [project("p1", { active: false, role: "admin" })]).title).toBe("Ваши проекты выключены");
    const admin = render({ ...OPERATOR, id: "a2" }, [project("p1", { active: false }), project("p4", { active: false, role: "admin", admin_id: "a2" })]);
    expect([admin.title, admin.action?.text()]).toEqual(["Проект выключен", "Настроить проект"]);
    expect(admin.text).toContain("«Проект p4»");
    await admin.action!.trigger("click");
    expect(useWorkspaceStore().admin).toEqual({ window: "projects", project: "p4", tab: "settings", create: false });
    const operator = render(OPERATOR, [project("p1", { active: false })]);
    expect([operator.title, operator.action]).toEqual(["Проект выключен", null]);
  });

  it("an available project that is not chosen is to be picked in the app bar", () => {
    expect(render(OPERATOR, [project("p1")])).toMatchObject({ title: "Выберите проект", action: null });
  });
});
