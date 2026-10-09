import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import type { TicketItem, TicketPage } from "../api/types";
import { useFoldersStore } from "./folders";
import { useProjectsStore } from "./projects";
import { useSessionStore } from "./session";

export const PAGE_SIZE = 50;

/** Revisions of what the client holds, so the server sends only rows that changed (at most 5000). */
export function known<T extends { revision: string }>(rows: Map<string, T>): Record<string, string> {
  return Object.fromEntries([...rows].slice(-5000).map(([id, row]) => [id, row.revision]));
}

/** The ticket list of the current project: search, archive, folder filter and pages of 50. */
export const useTicketsStore = defineStore("tickets", () => {
  const session = useSessionStore();
  const items = shallowRef(new Map<string, TicketItem>());
  const order = shallowRef<string[]>([]);
  const query = ref("");
  const archived = ref(false);
  /** "" shows every folder. */
  const folderFilter = ref("");
  const pages = ref(1);
  const hasMore = ref(false);
  /** The first answer for the current filters has arrived: an empty list now means "nothing here". */
  const loaded = ref(false);
  let epoch = 0;

  const rows = computed(() => order.value.map((id) => items.value.get(id)).filter((row) => row !== undefined));

  /**
   * Reloads every shown page. Folders come first: a filter on a folder another operator deleted is
   * dropped before the list is requested. An answer for older filters is discarded.
   */
  async function sync(): Promise<void> {
    const projects = useProjectsStore();
    const project = projects.currentId;
    if (!project) return;
    const generation = session.generation;
    await useFoldersStore().refresh();
    if (project !== projects.currentId || generation !== session.generation) return;
    const sent = ++epoch;
    const filters = { query: query.value, archived: archived.value, folder: folderFilter.value };
    const stale = (): boolean =>
      sent !== epoch || project !== projects.currentId || filters.query !== query.value
      || filters.archived !== archived.value || filters.folder !== folderFilter.value;
    const next = new Map(items.value);
    const previousOrder = order.value;
    const ids: string[] = [];
    let more = false;
    for (let page = 0; page < pages.value; page++) {
      // Bound revision hints to this page's previous rows. Sending all loaded
      // revisions on every page makes one refresh quadratic in the number of pages.
      // A ticket that moved here from another page is returned in full by the API.
      const pageKnown: Record<string, string> = {};
      for (const id of previousOrder.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
        const item = next.get(id);
        if (item) pageKnown[id] = item.revision;
      }
      const result = await session.api<TicketPage>("tickets/sync", {
        method: "POST",
        data: {
          known: pageKnown,
          query: filters.query,
          archived: filters.archived,
          offset: page * PAGE_SIZE,
          folder_id: filters.folder || null,
        },
      }, project);
      if (stale()) return;
      for (const item of result.items) next.set(item.id, item);
      ids.push(...result.order);
      more = result.order.length >= PAGE_SIZE;
    }
    const unique = [...new Set(ids)];
    const shown = new Set(unique);
    for (const id of next.keys()) if (!shown.has(id)) next.delete(id);
    items.value = next;
    order.value = unique;
    hasMore.value = more;
    loaded.value = true;
  }

  function setQuery(value: string): void {
    query.value = value;
    pages.value = 1;
  }

  function setArchived(value: boolean): void {
    if (archived.value === value) return;
    archived.value = value;
    pages.value = 1;
    loaded.value = false;
  }

  function setFolder(id: string): void {
    if (folderFilter.value === id) return;
    folderFilter.value = id;
    pages.value = 1;
    loaded.value = false;
  }

  function resetFolderFilter(): void {
    folderFilter.value = "";
    pages.value = 1;
  }

  function more(): void {
    pages.value++;
  }

  /** For another project: the archive mode stays, as in the classic console. */
  function reset(): void {
    epoch++;
    items.value = new Map();
    order.value = [];
    query.value = "";
    folderFilter.value = "";
    pages.value = 1;
    hasMore.value = false;
    loaded.value = false;
  }
  session.onSessionEnd(() => {
    reset();
    archived.value = false;
  });

  return {
    items, order, rows, query, archived, folderFilter, pages, hasMore, loaded,
    sync, setQuery, setArchived, setFolder, resetFolderFilter, more, reset,
  };
});
