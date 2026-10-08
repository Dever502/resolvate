import { defineStore } from "pinia";
import { ref } from "vue";
import type { Folder } from "../api/types";
import { useChatStore } from "./chat";
import { useProjectsStore } from "./projects";
import { useSessionStore } from "./session";
import { useTicketsStore } from "./tickets";
import { useWorkspaceStore } from "./workspace";

export const FOLDER_GONE = "Папка удалена другим оператором. Показаны все диалоги.";

/** Folders shared by the team of the current project. */
export const useFoldersStore = defineStore("folders", () => {
  const session = useSessionStore();
  const folders = ref<Folder[]>([]);
  /** A create, rename or delete is running; the folder dialogs wait for it. */
  const busy = ref(false);
  let request = 0;
  /** Changes with the project: work started for another project is not finished in this one. */
  let context = 0;

  async function refresh(): Promise<void> {
    const projects = useProjectsStore();
    const project = projects.currentId;
    if (!project) return;
    const sent = ++request;
    const list = await session.api<Folder[]>("folders", {}, project);
    if (project !== projects.currentId || sent !== request) return;
    if (JSON.stringify(list) !== JSON.stringify(folders.value)) folders.value = list;
    const tickets = useTicketsStore();
    if (tickets.folderFilter && !list.some((folder) => folder.id === tickets.folderFilter)) {
      tickets.resetFolderFilter();
      useWorkspaceStore().show(FOLDER_GONE);
    }
  }

  /**
   * Runs a folder change, then reloads folders, the list and the open dialogue whatever happened:
   * after a conflict (409) or a deleted folder (404) the shown data is stale too.
   */
  async function change(perform: () => Promise<unknown>, deletedId: string | null = null): Promise<void> {
    if (busy.value) return;
    const project = useProjectsStore().currentId;
    const started = context;
    busy.value = true;
    request++;
    let failure: unknown = null;
    try {
      await perform();
      if (started === context && deletedId && useTicketsStore().folderFilter === deletedId) {
        useTicketsStore().resetFolderFilter();
      }
    } catch (error) {
      failure = error;
    } finally {
      busy.value = false;
    }
    if (started !== context) return;
    try {
      await refresh();
      if (project === useProjectsStore().currentId) {
        await useTicketsStore().sync();
        if (useChatStore().ticketId) await useChatStore().syncDetail();
      }
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  }

  function create(name: string): Promise<void> {
    const project = useProjectsStore().currentId;
    return change(() => session.api("folders", { method: "POST", data: { name } }, project));
  }

  function rename(folder: Folder, name: string): Promise<void> {
    const project = useProjectsStore().currentId;
    return change(() => session.api(`folders/${folder.id}/rename`, {
      method: "POST", data: { name, revision: folder.revision },
    }, project));
  }

  function remove(folder: Folder): Promise<void> {
    const project = useProjectsStore().currentId;
    return change(() => session.api(`folders/${folder.id}/delete`, {
      method: "POST", data: { revision: folder.revision },
    }, project), folder.id);
  }

  function reset(): void {
    context++;
    request++;
    folders.value = [];
    busy.value = false;
  }
  session.onSessionEnd(reset);

  return { folders, busy, refresh, create, rename, remove, reset };
});
