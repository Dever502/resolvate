import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { Project } from "../api/types";
import { useChatStore } from "./chat";
import { useFoldersStore } from "./folders";
import { useSessionStore } from "./session";
import { useTicketsStore } from "./tickets";
import { useWorkspaceStore } from "./workspace";

export function logoUrl(project: Pick<Project, "id" | "logo">): string {
  return `/console/projects/${encodeURIComponent(project.id)}/logo?v=${encodeURIComponent(project.logo ?? "")}`;
}

/** Projects the account sees, and the one the workspace works in. */
export const useProjectsStore = defineStore("projects", () => {
  const session = useSessionStore();
  const all = ref<Project[]>([]);
  const currentId = ref<string | null>(null);
  /** Only projects the account is a member of, and only active ones, can be opened. */
  const available = computed(() => all.value.filter((project) => project.role && project.active));
  const current = computed(() => available.value.find((project) => project.id === currentId.value) ?? null);

  /**
   * Reloads the list. On the first load the first available project is chosen; later a project that
   * became unavailable is just deselected, without a notice.
   */
  async function refresh(initial: boolean): Promise<void> {
    const generation = session.generation;
    const projects = await session.api<Project[]>("projects");
    if (generation !== session.generation) return;
    const changed = JSON.stringify(projects) !== JSON.stringify(all.value);
    if (changed) all.value = projects;
    if (!changed && !initial) return;
    if (!current.value) select(initial ? (available.value[0]?.id ?? null) : null);
    if (initial) await useTicketsStore().sync();
  }

  /**
   * Switches the workspace to another project. Refused while a message is being sent; drops the
   * list, the dialogue, drafts and caches, which never carry over to another project.
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

  function reset(): void {
    all.value = [];
    currentId.value = null;
  }
  session.onSessionEnd(reset);

  return { all, currentId, available, current, refresh, select, reset };
});
