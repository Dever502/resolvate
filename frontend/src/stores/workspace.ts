import { defineStore } from "pinia";
import { ref } from "vue";
import { useChatStore } from "./chat";
import { useProjectsStore } from "./projects";
import { useSessionStore } from "./session";
import { useTicketsStore } from "./tickets";

export const FAILED = "Не удалось выполнить действие.";
export const NO_LINK_ACCESS = "Нет доступа к проекту из ссылки.";
export const WINDOW_UNAVAILABLE = "Не удалось загрузить раздел. Обновите страницу.";

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

  /** First load after sign-in: projects, the first available one, and the ?project=&ticket= link. */
  async function enter(): Promise<void> {
    const projects = useProjectsStore();
    startPending.value = true;
    await projects.refresh(true);
    startPending.value = false;
    const link = new URLSearchParams(location.search);
    const projectId = link.get("project");
    const ticketId = link.get("ticket");
    if (!projectId || !ticketId) return;
    if (!projects.available.some((project) => project.id === projectId)) {
      show(NO_LINK_ACCESS);
      return;
    }
    if (!projects.select(projectId)) return;
    await useTicketsStore().sync();
    await useChatStore().open(ticketId);
  }

  /** One live refresh: projects, the list, and the open dialogue. */
  async function refresh(): Promise<void> {
    const projects = useProjectsStore();
    const chat = useChatStore();
    const initial = startPending.value;
    await projects.refresh(initial);
    startPending.value = false;
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
  }
  session.onSessionEnd(reset);

  return {
    notice, dialogueOpen, startPending, refreshing, admin,
    show, fail, enter, refresh, openProjects, openStaff, closeAdmin, reset,
  };
});
