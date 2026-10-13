import { defineStore } from "pinia";
import { effectScope, ref, watch } from "vue";
import { ApiError } from "../api/client";
import { readNavigation, writeNavigation } from "../lib/navigation";
import { useChatStore } from "./chat";
import { useProjectsStore } from "./projects";
import { useSessionStore } from "./session";
import { useTicketsStore } from "./tickets";

export const FAILED = "Не удалось выполнить действие.";
export const NO_LINK_ACCESS = "Нет доступа к проекту из ссылки.";
export const WINDOW_UNAVAILABLE = "Не удалось загрузить раздел. Обновите страницу.";
export const PLACE_PROJECT_GONE = "Проект, открытый до обновления страницы, больше недоступен.";
export const PLACE_DIALOGUE_GONE = "Диалог, открытый до обновления страницы, недоступен: он удалён или доступ к нему закрыт.";

export type ProjectTab = "members" | "settings" | "logo";

/** The open administration window: the projects (one of them managed) or the staff of the installation. */
export type AdminView =
  | { window: "projects"; project: string | null; tab: ProjectTab; create: boolean }
  | { window: "staff" };

/** State the workspace areas share, and the start and refresh of the operator's data. */
export const useWorkspaceStore = defineStore("workspace", () => {
  const session = useSessionStore();
  /** Shown above the conversation, and above the list where the conversation is hidden. */
  const notice = ref("");
  /** Narrow screens show the list or the dialogue, never both: true means the dialogue. */
  const dialogueOpen = ref(false);
  /** The start after sign-in failed: the next refresh repeats it (first project, deep link). */
  const startPending = ref(false);
  /** A live refresh is running: loading older messages waits for it, and the other way round. */
  const refreshing = ref(false);
  /** Opened from the app bar and from the empty states; the windows check permissions with the server. */
  const admin = ref<AdminView | null>(null);

  function show(text = ""): void {
    notice.value = text;
  }

  function fail(error: unknown): void {
    notice.value = error instanceof Error && error.message ? error.message : FAILED;
  }

  /** Where the first load leads: the tab's place before a reload, or a ?project=&ticket= link. */
  let target: { project: string | null; ticket: string | null; link: boolean } | null = null;
  /** The tab's place is written only once it is known: a fresh sign-in must not erase the saved one. */
  let placeKnown = false;
  let following = false;
  /** Lives as long as the store: the workspace that first entered is unmounted by a sign-out. */
  const followScope = effectScope(true);

  /** Writes the tab's project and dialogue as they change, for the next reload. */
  function follow(): void {
    if (following) return;
    following = true;
    followScope.run(() => {
      watch([() => session.account?.id, () => useProjectsStore().currentId, () => useChatStore().ticketId], ([account, project, ticket]) => {
        if (account && placeKnown) writeNavigation({ account, project, ticket });
      });
    });
  }

  /** Opens the dialogue the tab had open; one that is gone or no longer allowed leaves the list as it is. */
  async function reopen(id: string): Promise<void> {
    const chat = useChatStore();
    try {
      await chat.open(id);
    } catch (error) {
      if (chat.ticketId !== id) return;
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        chat.close();
        show(PLACE_DIALOGUE_GONE);
      } else {
        // A passing failure: the dialogue and its draft stay, the live refresh tries again.
        fail(error);
      }
    }
  }

  /** A link is followed once: the address drops ?project=&ticket=, so a reload restores the tab's own place. */
  function forgetLink(): void {
    const url = new URL(location.href);
    url.searchParams.delete("project");
    url.searchParams.delete("ticket");
    history.replaceState(history.state, "", url);
  }

  /**
   * The first project list: the target's project when it is available (no detour through the first
   * one), its dialogue alongside the dialogue list, then the tab's place is followed.
   */
  async function begin(): Promise<void> {
    const projects = useProjectsStore();
    const chat = useChatStore();
    await projects.refresh(true, { preferred: target?.project ?? null, sync: false });
    startPending.value = false;
    const wanted = target;
    target = null;
    if (wanted?.link) forgetLink();
    const reached = wanted !== null && wanted.project !== null && projects.currentId === wanted.project;
    if (wanted?.project && !reached) show(wanted.link ? NO_LINK_ACCESS : PLACE_PROJECT_GONE);
    // A link's dialogue opens as any other; the tab's own dialogue that is gone just leaves the list.
    const dialogue = reached && wanted.ticket ? (wanted.link ? chat.open(wanted.ticket) : reopen(wanted.ticket)) : null;
    try {
      await Promise.all([useTicketsStore().sync(), dialogue]);
    } finally {
      placeKnown = true;
      const account = session.account?.id;
      if (account) writeNavigation({ account, project: projects.currentId, ticket: chat.ticketId });
    }
  }

  /**
   * First load after sign-in: projects, then the dialogue of a ?project=&ticket= link, or else the
   * tab's project and dialogue from before a reload (or the first available project).
   */
  async function enter(): Promise<void> {
    const link = new URLSearchParams(location.search);
    const project = link.get("project");
    const ticket = link.get("ticket");
    const account = session.account?.id;
    const saved = account && !(project && ticket) ? readNavigation(account) : null;
    target = project && ticket ? { project, ticket, link: true } : saved && { project: saved.project, ticket: saved.ticket, link: false };
    follow();
    startPending.value = true;
    await begin();
  }

  /** One live refresh: projects, the list, and the open dialogue. A failed first load is repeated whole. */
  async function refresh(): Promise<void> {
    const projects = useProjectsStore();
    const chat = useChatStore();
    if (startPending.value) {
      await begin();
      return;
    }
    await projects.refresh(false);
    await useTicketsStore().sync();
    if (chat.ticketId && !chat.opening && !chat.unavailable) {
      await Promise.all([chat.syncDetail(), chat.syncMessages()]);
    }
  }

  /** The projects window: the list, the new project form, or one project's management screen. */
  function openProjects(options: { project?: string; tab?: ProjectTab; create?: boolean } = {}): void {
    admin.value = { window: "projects", project: options.project ?? null, tab: options.tab ?? "members", create: options.create ?? false };
  }

  function openStaff(): void {
    admin.value = { window: "staff" };
  }

  function closeAdmin(): void {
    admin.value = null;
  }

  function reset(): void {
    notice.value = "";
    dialogueOpen.value = false;
    startPending.value = false;
    refreshing.value = false;
    admin.value = null;
    target = null;
    placeKnown = false;
  }
  session.onSessionEnd(reset);

  return {
    notice, dialogueOpen, startPending, refreshing, admin,
    show, fail, enter, refresh, openProjects, openStaff, closeAdmin, reset,
  };
});
