import { defineStore } from "pinia";
import { computed, reactive, ref, shallowRef } from "vue";
import { ApiError } from "../api/client";
import type { FolderAssignment, Message, MessagePage, TicketDetail, TicketHeading } from "../api/types";
import { useProjectsStore } from "./projects";
import { useSessionStore } from "./session";
import { known, useTicketsStore } from "./tickets";
import { useWorkspaceStore } from "./workspace";

export const UNCERTAIN = "Результат одной из отправок неизвестен. Проверьте Telegram перед повторной отправкой.";
export const FILE_TOO_LARGE = "Файл больше 20 МБ.";
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** A dialogue opened again within this time shows its cached history at once, then refreshes it. */
export const CACHE_AGE = 120_000;
export const CACHE_TICKETS = 20;
export const CACHE_MESSAGES = 200;

/** Text and file waiting to be sent. `key` makes a retried send idempotent; any edit drops it. */
export interface Draft {
  text: string;
  file: File | null;
  key: string | null;
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
  const cache = new Map<string, Snapshot>();
  let epoch = 0;
  let detailRequest = 0;
  let messageRequest = 0;
  let historyUpdatedAt = 0;
  let openController: AbortController | null = null;
  let lastRead = "";

  const ordered = computed(() => [...messages.value.values()].sort(byTime));
  const draft = computed(() => (ticketId.value ? drafts.get(ticketId.value) ?? null : null));
  const closed = computed(() => (detail.value ?? heading.value).status === "closed");

  const project = (): string | null => useProjectsStore().currentId;
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
    if (!drafts.has(id)) drafts.set(id, { text: "", file: null, key: null });
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
    current.key = null;
    return true;
  }

  function edit(text: string): void {
    const current = draft.value;
    if (!current) return;
    current.text = text;
    current.key = null;
  }

  async function send(): Promise<void> {
    const id = ticketId.value;
    const current = draft.value;
    if (!id || !current || sending.value) return;
    if (!current.text.trim() && !current.file) return;
    current.key ||= crypto.randomUUID();
    const form = new FormData();
    form.set("text", current.text);
    if (current.file) form.set("file", current.file);
    sending.value = true;
    try {
      await session.api(`tickets/${id}/send`, { method: "POST", form, key: current.key }, project());
      drafts.delete(id);
      if (ticketId.value === id) drafts.set(id, { text: "", file: null, key: null });
      workspace().show();
      await syncMessages();
      await useTicketsStore().sync();
      await syncDetail();
    } catch (error) {
      workspace().fail(error);
    } finally {
      sending.value = false;
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
  session.onSessionEnd(reset);

  return {
    ticketId, detail, heading, messages, ordered, before, hasOlder, loadingOlder, opening, sending,
    lifecycleBusy, unavailable, folderMove, change, viewer, drafts, draft, closed,
    open, syncDetail, syncMessages, loadOlder, markRead, attach, edit, send, retry, toggleClosed,
    moveToFolder, reset,
  };
});
