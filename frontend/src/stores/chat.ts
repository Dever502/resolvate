import { defineStore } from "pinia";
import { computed, reactive, ref, shallowRef } from "vue";
import { ApiError } from "../api/client";
import type { FolderAssignment, Message, MessagePage, TicketDetail, TicketHeading } from "../api/types";
import { useProjectsStore } from "./projects";
import { useSessionStore } from "./session";
import { known, useTicketsStore } from "./tickets";
import { FAILED, useWorkspaceStore } from "./workspace";

export const UNCERTAIN = "Результат одной из отправок неизвестен. Проверьте Telegram перед повторной отправкой.";
/** How long a send waits for the server's answer, plus the upload of a file at UPLOAD_RATE bytes a second. */
export const SEND_TIMEOUT = 30_000;
export const UPLOAD_RATE = 32 * 1024;
/** The deadline of one send: a slow connection still gets its file through, a hung request ends. */
export function sendDeadline(file: File | null): number {
  return SEND_TIMEOUT + (file ? Math.ceil(file.size / UPLOAD_RATE) * 1000 : 0);
}
export const SEND_BLOCKED = "Сначала повторите предыдущую отправку или откажитесь от неё: её результат неизвестен.";
export const SEND_FOUND = "Сообщение из отправки с неизвестным результатом есть в истории: сервер его принял.";
export const SEND_REFRESH_FAILED = "Сообщение принято сервером, но историю не удалось обновить";
export const FILE_TOO_LARGE = "Файл больше 20 МБ.";
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** A dialogue opened again within this time shows its cached history at once, then refreshes it. */
export const CACHE_AGE = 120_000;
export const CACHE_TICKETS = 20;
export const CACHE_MESSAGES = 200;

/** What the operator is writing in one dialogue: editable at any time. */
export interface Draft {
  text: string;
  file: File | null;
}

/**
 * One press of "Отправить": a frozen copy of the text and the file with the idempotency key they went
 * under. Kept while its outcome is unknown (no answer in time, a lost connection, a proxy error): a
 * retry sends exactly this copy under this key, so the server returns the message it already saved or
 * saves it once. Editing the draft never changes it; the server refuses the key with other content.
 */
export interface SendAttempt {
  key: string;
  project: string;
  ticket: string;
  text: string;
  file: File | null;
  state: "sending" | "unknown";
  /** Why the outcome is unknown: the connection, the deadline or the server's answer. */
  reason: string;
  /** Requests sent for this attempt so far. */
  tries: number;
}

/**
 * How a send ended: the server took the message, refused it (nothing saved, the draft stays), or its
 * answer never came. "blocked": an attempt with an unknown outcome waits for a retry or for being
 * given up first; "skipped": nothing to send or another send runs.
 */
export type SendOutcome = "accepted" | "rejected" | "unknown" | "blocked" | "skipped";

/**
 * Only the application's own refusal (4xx) of an attempt's first request proves nothing was saved;
 * anything else may have been. A retry refused (rate limit, a gone project, a file check that timed
 * out) proves nothing about the request before it.
 */
function refused(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

interface Snapshot {
  messages: Map<string, Message>;
  detail: TicketDetail | null;
  before: string | null;
  hasOlder: boolean;
  updatedAt: number;
}

/** How the last change to the history came about: the message list keeps its scroll accordingly. */
export type HistoryChange = "initial" | "older" | "update";

export function byTime(a: Message, b: Message): number {
  return a.time.localeCompare(b.time) || a.id.localeCompare(b.id);
}

/** The open dialogue: customer, history, drafts, sending and the dialogue's own actions. */
export const useChatStore = defineStore("chat", () => {
  const session = useSessionStore();
  const ticketId = ref<string | null>(null);
  /** Authorized detail of the open ticket; actions stay disabled until it arrives. */
  const detail = ref<TicketDetail | null>(null);
  /** What the header shows meanwhile: the list row or the cached detail. */
  const heading = ref<TicketHeading>({});
  const messages = shallowRef(new Map<string, Message>());
  const before = ref<string | null>(null);
  const hasOlder = ref(false);
  const loadingOlder = ref(false);
  const opening = ref(false);
  const sending = ref(false);
  const lifecycleBusy = ref(false);
  /** The ticket answered 403 or 404: it is not polled again until it is opened again. */
  const unavailable = ref(false);
  const folderMove = reactive({ busy: false, status: "" });
  const change = ref<{ kind: HistoryChange; count: number }>({ kind: "initial", count: 0 });
  /** Address of the image shown in the viewer; closed with the dialogue. */
  const viewer = ref<string | null>(null);
  const drafts = reactive(new Map<string, Draft>());
  /** Attempts with an unknown outcome (or still running), by project and dialogue; they outlive a project switch. */
  const attempts = reactive(new Map<string, SendAttempt>());
  const cache = new Map<string, Snapshot>();
  let epoch = 0;
  let signedIn = 0;
  let detailRequest = 0;
  let messageRequest = 0;
  let historyUpdatedAt = 0;
  let openController: AbortController | null = null;
  let lastRead = "";

  const ordered = computed(() => [...messages.value.values()].sort(byTime));
  const draft = computed(() => (ticketId.value ? drafts.get(ticketId.value) ?? null : null));
  const closed = computed(() => (detail.value ?? heading.value).status === "closed");

  const project = (): string | null => useProjectsStore().currentId;
  const slot = (projectId: string, id: string): string => `${projectId}/${id}`;
  /** The open dialogue's attempt that has not ended yet. */
  const attempt = computed(() => {
    const projectId = project();
    return ticketId.value && projectId ? attempts.get(slot(projectId, ticketId.value)) ?? null : null;
  });
  const workspace = () => useWorkspaceStore();

  function touched(kind: HistoryChange): void {
    change.value = { kind, count: change.value.count + 1 };
  }

  /** Keeps the history of the dialogue being left for a quick return (bounded by age and size). */
  function remember(): void {
    const id = ticketId.value;
    if (!id) return;
    cache.delete(id);
    if (!historyUpdatedAt || messages.value.size > CACHE_MESSAGES) return;
    cache.set(id, {
      messages: new Map(messages.value), detail: detail.value,
      before: before.value, hasOlder: hasOlder.value, updatedAt: historyUpdatedAt,
    });
    while (cache.size > CACHE_TICKETS) cache.delete(cache.keys().next().value!);
  }

  async function open(id: string): Promise<void> {
    if (sending.value) return;
    remember();
    openController?.abort();
    const controller = new AbortController();
    openController = controller;
    const opened = ++epoch;
    ticketId.value = id;
    detail.value = null;
    unavailable.value = false;
    folderMove.busy = false;
    folderMove.status = "";
    viewer.value = null;
    lastRead = "";
    if (!drafts.has(id)) drafts.set(id, { text: "", file: null });
    const cached = cache.get(id);
    const snapshot = cached && Date.now() - cached.updatedAt < CACHE_AGE ? cached : null;
    messages.value = new Map(snapshot?.messages);
    historyUpdatedAt = snapshot?.updatedAt ?? 0;
    before.value = snapshot?.before ?? null;
    hasOlder.value = snapshot?.hasOlder ?? false;
    loadingOlder.value = false;
    const row = useTicketsStore().items.get(id);
    heading.value = snapshot?.detail ?? { display_name: row?.name, channel: row?.channel, status: row?.status };
    touched("initial");
    workspace().dialogueOpen = true;
    opening.value = true;
    try {
      await Promise.all([syncDetail(controller.signal), syncMessages({ initial: true, signal: controller.signal })]);
    } catch (error) {
      if (opened !== epoch || controller.signal.aborted) return;
      controller.abort();
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        cache.delete(id);
        messages.value = new Map();
        historyUpdatedAt = 0;
        detail.value = null;
        heading.value = {};
        unavailable.value = error.status !== 401;
        touched("initial");
      }
      throw error;
    } finally {
      if (openController === controller) {
        openController = null;
        opening.value = false;
      }
    }
  }

  async function syncDetail(signal?: AbortSignal): Promise<void> {
    const id = ticketId.value;
    if (!id) return;
    const at = epoch;
    const sent = ++detailRequest;
    const result = await session.api<TicketDetail>(`tickets/${id}`, signal ? { signal } : {}, project());
    if (signal?.aborted || at !== epoch || id !== ticketId.value || sent !== detailRequest) return;
    detail.value = result;
    heading.value = result;
  }

  async function syncMessages({ initial = false, older = false, signal }: {
    initial?: boolean; older?: boolean; signal?: AbortSignal;
  } = {}): Promise<void> {
    const id = ticketId.value;
    if (!id) return;
    const at = epoch;
    const sent = ++messageRequest;
    const hadHistory = historyUpdatedAt > 0;
    const result = await session.api<MessagePage>(`tickets/${id}/sync`, {
      method: "POST",
      data: { known: older ? {} : known(messages.value), before: older ? before.value : null },
      ...(signal ? { signal } : {}),
    }, project());
    if (signal?.aborted || at !== epoch || id !== ticketId.value || sent !== messageRequest) return;
    let first = initial;
    const next = new Map(messages.value);
    if (result.reset) {
      next.clear();
      first = true;
    }
    for (const item of result.items) next.set(item.id, item);
    if (!older) for (const removed of result.removed) next.delete(removed);
    if (older || result.reset || (first && !hadHistory)) {
      before.value = result.before;
      hasOlder.value = result.has_older;
    }
    messages.value = next;
    historyUpdatedAt = Date.now();
    touched(older ? "older" : first ? "initial" : "update");
    if ([...next.values()].some((item) => item.uncertain)) workspace().show(UNCERTAIN);
    // A message the console sent carries its key: an attempt whose answer was lost was taken after all.
    const pending = attempt.value;
    if (pending?.state === "unknown" && [...next.values()].some((item) => item.command === pending.key)) {
      accepted(pending);
      workspace().show(SEND_FOUND);
    }
  }

  async function loadOlder(): Promise<void> {
    if (loadingOlder.value || opening.value || workspace().refreshing || !hasOlder.value) return;
    const at = epoch;
    loadingOlder.value = true;
    try {
      await syncMessages({ older: true });
    } catch (error) {
      workspace().fail(error);
    } finally {
      if (at === epoch) loadingOlder.value = false;
    }
  }

  /** Marks the history read up to `messageId`; sent once per message, without holding up anything. */
  function markRead(messageId: string): void {
    const id = ticketId.value;
    if (!id || messageId === lastRead) return;
    lastRead = messageId;
    const at = epoch;
    session.api(`tickets/${id}/read/${messageId}`, { method: "POST" }, project()).catch((error: unknown) => {
      if (at !== epoch) return;
      lastRead = "";
      workspace().fail(error);
    });
  }

  function attach(file: File | null): boolean {
    const current = draft.value;
    if (!current) return false;
    if (file && file.size > MAX_FILE_BYTES) {
      workspace().show(FILE_TOO_LARGE);
      return false;
    }
    current.file = file;
    return true;
  }

  function edit(text: string): void {
    const current = draft.value;
    if (current) current.text = text;
  }

  /**
   * Sends the open dialogue's draft as a new attempt. An attempt whose outcome is unknown comes first:
   * the same text and file again send it once more under its key, anything else waits for it.
   */
  async function send(): Promise<SendOutcome> {
    const id = ticketId.value;
    const projectId = project();
    const current = draft.value;
    if (!id || !projectId || !current || sending.value) return "skipped";
    const pending = attempts.get(slot(projectId, id));
    if (pending) {
      if (pending.text === current.text && pending.file === current.file) return deliver(pending);
      workspace().show(SEND_BLOCKED);
      return "blocked";
    }
    if (!current.text.trim() && !current.file) return "skipped";
    attempts.set(slot(projectId, id), {
      key: crypto.randomUUID(), project: projectId, ticket: id, text: current.text, file: current.file,
      state: "sending", reason: "", tries: 0,
    });
    return deliver(attempts.get(slot(projectId, id))!);
  }

  /** Sends the open dialogue's attempt with an unknown outcome again: its own text, file and key. */
  async function retrySend(): Promise<SendOutcome> {
    const pending = attempt.value;
    if (!pending || sending.value) return "skipped";
    return deliver(pending);
  }

  /** The operator gives up an attempt with an unknown outcome (for example, seen in Telegram); the draft stays. */
  function forgetAttempt(): void {
    const pending = attempt.value;
    if (pending?.state === "unknown") attempts.delete(slot(pending.project, pending.ticket));
  }

  /** One request of an attempt, bounded by its deadline; one at a time. */
  async function deliver(pending: SendAttempt): Promise<SendOutcome> {
    const session0 = signedIn;
    const form = new FormData();
    form.set("text", pending.text);
    if (pending.file) form.set("file", pending.file);
    const timeout = sendDeadline(pending.file);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), timeout);
    pending.state = "sending";
    pending.tries++;
    sending.value = true;
    workspace().show();
    try {
      await session.api(`tickets/${pending.ticket}/send`, {
        method: "POST", form, key: pending.key, signal: controller.signal,
      }, pending.project);
    } catch (error) {
      if (session0 !== signedIn) return "skipped";
      if (refused(error) && pending.tries === 1) {
        // Nothing was saved: the attempt is over and the draft is there to be fixed.
        attempts.delete(slot(pending.project, pending.ticket));
        workspace().fail(error);
        return "rejected";
      }
      pending.state = "unknown";
      const seconds = Math.round(timeout / 1000);
      pending.reason = controller.signal.aborted
        ? `Сервер не ответил за ${seconds >= 120 ? `${Math.round(seconds / 60)} мин` : `${seconds} с`}.`
        : error instanceof Error && error.message ? error.message : FAILED;
      return "unknown";
    } finally {
      clearTimeout(deadline);
      if (session0 === signedIn) sending.value = false;
    }
    if (session0 !== signedIn) return "skipped";
    accepted(pending);
    // The message is saved: a history or list that fails to reload says so, never as a failed send.
    try {
      if (ticketId.value === pending.ticket && project() === pending.project) {
        await syncMessages();
        await useTicketsStore().sync();
        await syncDetail();
      }
    } catch (error) {
      if (session0 === signedIn) workspace().show(`${SEND_REFRESH_FAILED}: ${error instanceof Error && error.message ? error.message : FAILED}`);
    }
    return "accepted";
  }

  /** The server took the attempt: it ends, and so does a draft that still holds just what was sent. */
  function accepted(pending: SendAttempt): void {
    attempts.delete(slot(pending.project, pending.ticket));
    if (project() !== pending.project) return;
    const current = drafts.get(pending.ticket);
    if (current && current.text === pending.text && current.file === pending.file) {
      drafts.set(pending.ticket, { text: "", file: null });
    }
  }

  async function retry(message: Message): Promise<void> {
    try {
      for (const delivery of message.failed) {
        await session.api(`retry/${message.command}/${delivery}`, { method: "POST" }, project());
      }
      await syncMessages();
    } catch (error) {
      workspace().fail(error);
    }
  }

  /** Closes an open dialogue or reopens a closed one. */
  async function toggleClosed(): Promise<void> {
    const id = ticketId.value;
    if (!id || !detail.value || lifecycleBusy.value) return;
    lifecycleBusy.value = true;
    try {
      await session.api(`tickets/${id}/${detail.value.status === "closed" ? "reopen" : "close"}`, { method: "POST" }, project());
      await syncDetail();
      await useTicketsStore().sync();
    } catch (error) {
      workspace().fail(error);
    } finally {
      lifecycleBusy.value = false;
    }
  }

  /** Moves the dialogue to a folder (null: no folder); a conflicting change by someone else is refused. */
  async function moveToFolder(folderId: string | null): Promise<void> {
    const id = ticketId.value;
    if (!id || !detail.value || folderMove.busy) return;
    const at = epoch;
    const currentProject = project();
    const revision = detail.value.folder_revision;
    folderMove.busy = true;
    detailRequest++; // A detail answer already on its way would show the old folder.
    folderMove.status = "Сохраняем…";
    try {
      await session.api<FolderAssignment>(`tickets/${id}/folder`, {
        method: "POST", data: { folder_id: folderId, revision },
      }, currentProject);
      if (at === epoch) folderMove.status = "Сохранено для команды";
    } catch (error) {
      if (at === epoch) folderMove.status = error instanceof Error ? error.message : "Не удалось перенести диалог.";
    } finally {
      if (at === epoch && currentProject === project()) {
        folderMove.busy = false;
        try {
          await syncDetail();
          await useTicketsStore().sync();
        } catch (error) {
          if (at === epoch) workspace().fail(error);
        }
      }
    }
  }

  /** For another project or after sign-out: nothing of the dialogue, its drafts or caches remains. */
  function reset(): void {
    epoch++;
    openController?.abort();
    openController = null;
    ticketId.value = null;
    detail.value = null;
    heading.value = {};
    messages.value = new Map();
    before.value = null;
    hasOlder.value = false;
    loadingOlder.value = false;
    opening.value = false;
    sending.value = false;
    lifecycleBusy.value = false;
    unavailable.value = false;
    folderMove.busy = false;
    folderMove.status = "";
    viewer.value = null;
    drafts.clear();
    cache.clear();
    historyUpdatedAt = 0;
    lastRead = "";
    touched("initial");
  }
  // Attempts outlive a project switch (reset), not the session: another account may sign in.
  session.onSessionEnd(() => {
    signedIn++;
    reset();
    attempts.clear();
  });

  return {
    ticketId, detail, heading, messages, ordered, before, hasOlder, loadingOlder, opening, sending,
    lifecycleBusy, unavailable, folderMove, change, viewer, drafts, draft, attempts, attempt, closed,
    open, syncDetail, syncMessages, loadOlder, markRead, attach, edit, send, retrySend, forgetAttempt, retry,
    toggleClosed, moveToFolder, reset,
  };
});
