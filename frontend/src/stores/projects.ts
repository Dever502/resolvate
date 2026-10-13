import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { Project } from "../api/types";
import { useChatStore } from "./chat";
import { useFoldersStore } from "./folders";
import { useSessionStore } from "./session";
import { useTicketsStore } from "./tickets";
import { FAILED, useWorkspaceStore } from "./workspace";

export function logoUrl(project: Pick<Project, "id" | "logo">): string {
  return `/console/projects/${encodeURIComponent(project.id)}/logo?v=${encodeURIComponent(project.logo ?? "")}`;
}

/** Projects the account sees, the one the workspace works in, and the changes administrators make. */
export const useProjectsStore = defineStore("projects", () => {
  const session = useSessionStore();
  const all = ref<Project[]>([]);
  const currentId = ref<string | null>(null);
  /** The list has been received at least once in this session: an empty list means "no projects". */
  const loaded = ref(false);
  /** Why the list could not be received yet; never shown as "no projects". */
  const error = ref("");
  /** Only projects the account is a member of, and only active ones, can be opened. */
  const available = computed(() => all.value.filter((project) => project.role && project.active));
  const current = computed(() => available.value.find((project) => project.id === currentId.value) ?? null);

  /**
   * Reloads the list. On the first load the project this tab worked in (`preferred`, if it is still
   * available) is chosen, else the first available one; later a project that became unavailable is
   * just deselected, without a notice. `sync: false` leaves the first list load to the caller.
   */
  async function refresh(initial: boolean, { preferred = null, sync = true }: { preferred?: string | null; sync?: boolean } = {}): Promise<void> {
    const generation = session.generation;
    let projects: Project[];
    try {
      projects = await session.api<Project[]>("projects");
    } catch (caught) {
      if (generation === session.generation && !loaded.value) {
        error.value = caught instanceof Error && caught.message ? caught.message : FAILED;
      }
      throw caught;
    }
    if (generation !== session.generation) return;
    loaded.value = true;
    error.value = "";
    const changed = JSON.stringify(projects) !== JSON.stringify(all.value);
    if (changed) all.value = projects;
    if (!changed && !initial) return;
    if (!current.value) {
      const back = preferred && available.value.some((project) => project.id === preferred) ? preferred : null;
      select(initial ? (back ?? available.value[0]?.id ?? null) : null);
    }
    if (initial && sync) await useTicketsStore().sync();
  }

  /**
   * Switches the workspace to another project. Refused while a message is being sent; drops the
   * list, the dialogue and caches, which never carry over to another project. Drafts and unfinished
   * sends stay in the browser's storage and come back with their dialogues.
   */
  function select(id: string | null): boolean {
    if (useChatStore().sending) return false;
    currentId.value = id;
    useFoldersStore().reset();
    useTicketsStore().reset();
    useChatStore().reset();
    const workspace = useWorkspaceStore();
    workspace.show();
    workspace.dialogueOpen = false;
    return true;
  }

  // Administration (src/resolvate/project_routes.py). The server checks every permission; after a
  // change the list is reloaded, so the project menu, logos and roles follow at once.
  async function follow(): Promise<void> {
    try {
      await refresh(false);
    } catch {
      // The change itself succeeded; a list that fails now is reported by the next live refresh.
    }
  }

  async function change(path: string, data?: unknown): Promise<void> {
    await session.api(path, { method: "POST", data });
    await follow();
  }

  /** Installation administrator: a new, switched-off project with its administrator. */
  async function create(name: string, adminLogin: string): Promise<string> {
    const created = await session.api<{ id: string }>("projects", { method: "POST", data: { name, admin_login: adminLogin } });
    await follow();
    return created.id;
  }

  function setActive(id: string, active: boolean): Promise<void> {
    return change(`projects/${id}/active`, { active });
  }

  /** Grants access to the project's correspondence; with the own login, to oneself. */
  function grant(id: string, login: string): Promise<void> {
    return change(`projects/${id}/members`, { login });
  }

  function revoke(id: string, login: string): Promise<void> {
    return change(`projects/${id}/members/remove`, { login });
  }

  /** Installation administrator: another administrator for the project; the previous one loses access. */
  function transfer(id: string, login: string): Promise<void> {
    return change(`projects/${id}/admin`, { login });
  }

  /** Project administrator: a new logo; the list then carries its new version, so every image updates. */
  async function uploadLogo(id: string, file: File): Promise<void> {
    const form = new FormData();
    form.set("file", file);
    await session.api(`projects/${id}/logo`, { method: "POST", form });
    await follow();
  }

  function removeLogo(id: string): Promise<void> {
    return change(`projects/${id}/logo/remove`);
  }

  function reset(): void {
    all.value = [];
    currentId.value = null;
    loaded.value = false;
    error.value = "";
  }
  session.onSessionEnd(reset);

  return {
    all, currentId, loaded, error, available, current,
    refresh, select, create, setActive, grant, revoke, transfer, uploadLogo, removeLogo, reset,
  };
});
