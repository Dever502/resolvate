import { onScopeDispose, watch } from "vue";
import { useChatStore } from "../stores/chat";
import { useProjectsStore } from "../stores/projects";
import { useSessionStore } from "../stores/session";
import { useWorkspaceStore } from "../stores/workspace";

/** Poll intervals: with a live event stream, without one, and right after a change signal. */
export const POLL_WITH_EVENTS = 30_000;
export const POLL_WITHOUT_EVENTS = 3_000;
export const POLL_REQUESTED = 500;
/** Bursts of change signals are merged: at most one refresh per this interval. */
export const REFRESH_SPACING = 1_500;
/** A closed event stream (for example 429: four streams per account) is reopened after this time. */
export const EVENTS_RETRY = 10_000;
export const ACCESS_CHANGED = "Доступ к проекту изменился. Выберите доступный проект.";

/**
 * Keeps the workspace current, as the classic console did: a server-sent event stream per project
 * signals changes (no data travels in it), and polling covers the time the stream is unavailable.
 * Nothing runs while the tab is hidden. The refresh itself is `workspace.refresh()`.
 */
export function useLiveUpdates(): void {
  const session = useSessionStore();
  const projects = useProjectsStore();
  const chat = useChatStore();
  const workspace = useWorkspaceStore();
  let source: EventSource | null = null;
  let ready = false;
  let retryAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let requested = false;
  let lastRefresh = 0;
  let stopped = false;

  function stopEvents(): void {
    source?.close();
    source = null;
    ready = false;
    retryAt = 0;
    requested = false;
  }

  function schedule(delay: number): void {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(poll, delay);
  }

  function requestRefresh(): void {
    requested = true;
    schedule(Math.max(100, lastRefresh + REFRESH_SPACING - Date.now()));
  }

  function startEvents(): void {
    const project = projects.currentId;
    if (stopped || source || Date.now() < retryAt || session.status !== "signed-in" || !project
      || document.hidden || !("EventSource" in window)) return;
    const generation = session.generation;
    const stream = new EventSource(`/console/projects/${encodeURIComponent(project)}/events`);
    source = stream;
    const current = (): boolean =>
      source === stream && projects.currentId === project && session.generation === generation;
    stream.addEventListener("ready", () => {
      if (!current()) return;
      ready = true;
      requestRefresh(); // Includes what changed while the stream was reconnecting.
    });
    stream.addEventListener("change", () => {
      if (current()) requestRefresh();
    });
    stream.addEventListener("revoked", (event) => {
      if (!current()) return;
      const status = (JSON.parse((event as MessageEvent<string>).data) as { status?: number }).status;
      stopEvents();
      if (status === 401) {
        session.signOut();
        return;
      }
      projects.select(null);
      projects.refresh(false).catch((error: unknown) => workspace.fail(error));
      workspace.show(ACCESS_CHANGED);
    });
    stream.onerror = () => {
      if (!current()) return;
      ready = false;
      if (stream.readyState === EventSource.CLOSED) {
        stream.close();
        source = null;
        retryAt = Date.now() + EVENTS_RETRY;
      }
      requestRefresh(); // The browser reconnects by itself; polling covers the gap.
    };
  }

  async function poll(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    startEvents();
    if (session.status === "signed-in" && !document.hidden && !workspace.refreshing
      && !chat.opening && !chat.sending && !chat.loadingOlder) {
      requested = false;
      lastRefresh = Date.now();
      workspace.refreshing = true;
      try {
        await workspace.refresh();
      } catch (error) {
        workspace.fail(error);
      } finally {
        workspace.refreshing = false;
      }
    }
    schedule(requested ? POLL_REQUESTED : ready ? POLL_WITH_EVENTS : POLL_WITHOUT_EVENTS);
  }

  function onVisibility(): void {
    if (document.hidden) stopEvents();
    else {
      startEvents();
      requestRefresh();
    }
  }
  function onPageShow(): void {
    startEvents();
    requestRefresh();
  }

  // Another project needs its own stream.
  watch(() => projects.currentId, () => {
    stopEvents();
    startEvents();
  });
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", stopEvents);
  window.addEventListener("pageshow", onPageShow);
  schedule(POLL_WITHOUT_EVENTS);
  startEvents();

  onScopeDispose(() => {
    stopped = true;
    clearTimeout(timer);
    stopEvents();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", stopEvents);
    window.removeEventListener("pageshow", onPageShow);
  });
}
