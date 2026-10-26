import { defineStore } from "pinia";
import { computed, reactive, ref, shallowRef, toRaw, watch } from "vue";
import { ApiError } from "../api/client";
import type { FolderAssignment, Message, MessagePage, TicketDetail, TicketHeading } from "../api/types";
import { FILES_LIMIT, MAX_FILES, fileProblem, quoted, refusal, textLength, textProblem } from "../lib/attachment";
import { keepUnsaved, takeUnsaved } from "../lib/navigation";
import {
  DRAFT_VERSION, StorageError, createAttempt, fileBytes, patience, readAttempt, readDraft, removeAttempt, removeDraft,
  restoreDraft, sameFile, updateAttempt, writeDraft, type StoredAttempt, type StoredDraft, type WorkScope,
} from "../lib/workStore";
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
/** Text edits wait this long before they are written to the browser's storage; a file goes at once. */
export const DRAFT_SAVE_DELAY = 300;
/** An attempt this old may have outlived the server's memory of its key (an archived dialogue's history is removed). */
export const ATTEMPT_AGE_WARNING = 24 * 60 * 60 * 1000;
/** A stored attempt read back: this page never got its answer (a reload, or a send still running in another tab). */
export const ATTEMPT_RELOADED = "Ответ сервера не получен: страница обновилась во время отправки или отправка идёт в другой вкладке.";
export const ATTEMPT_ELSEWHERE = "В другой вкладке есть отправка в этот диалог с неизвестным результатом: сначала повторите её или откажитесь от неё.";
export const DRAFT_CONFLICT = "Черновик этого диалога меняли в другой вкладке: сохранён текст из этой вкладки.";
export const STORAGE_OFF = "Браузер не сохраняет черновики и отправки: они пропадут после обновления страницы, черновики — и после смены проекта.";
export const lostFile = (names: string[]): string => names.length === 1
  ? `Вложение ${quoted(names[0]!)} не удалось сохранить в браузере: после обновления страницы прикрепите его снова.`
  : `Вложения ${names.map(quoted).join(", ")} не удалось сохранить в браузере: после обновления страницы прикрепите их снова.`;
export const lostAfterReload = (names: string[]): string => names.length === 1
  ? `Вложение ${quoted(names[0]!)} не сохранилось в браузере: прикрепите его снова.`
  : `Вложения ${names.map(quoted).join(", ")} не сохранились в браузере: прикрепите их снова.`;
/** Tells this tab's writes from another tab's. */
const TAB = crypto.randomUUID();
/** A dialogue opened again within this time shows its cached history at once, then refreshes it. */
export const CACHE_AGE = 120_000;
/** A read receipt that failed is sent again on a later look at the history, not on every scroll event. */
export const READ_RETRY_DELAY = 5_000;
export const CACHE_TICKETS = 20;
export const CACHE_MESSAGES = 200;

/** What the operator is writing in one dialogue: editable at any time. */
export interface Draft {
  text: string;
  /** Up to MAX_FILES, in the order they were attached; the text is the first one's caption. */
  files: File[];
}

const fileIds = new WeakMap<File, string>();
/** A file's id in its draft: the key of its bytes in the browser's storage and of its card in the reply box. */
export function fileId(file: File): string {
  file = toRaw(file);
  let id = fileIds.get(file);
  if (!id) {
    id = crypto.randomUUID();
    fileIds.set(file, id);
  }
  return id;
}

/**
 * One message of a press of "Отправить": the text alone, or one file (the first with the text as its
 * caption), a frozen copy with the idempotency key it went under. Kept while its outcome is unknown (no
 * answer in time, a lost connection, a proxy error): a retry sends exactly this copy under this key, so
 * the server returns the message it already saved or saves it once. Editing the draft never changes
 * it; the server refuses the key with other content.
 */
export interface SendAttempt {
  key: string;
  project: string;
  ticket: string;
  text: string;
  file: File | null;
  draftFileId?: string;
  state: "sending" | "unknown";
  /** Why the outcome is unknown: the connection, the deadline or the server's answer. */
  reason: string;
  /** Requests sent for this attempt so far. */
  tries: number;
  createdAt: number;
  /** Kept in the browser's storage: a reload restores it. False when the storage refused it. */
  persisted: boolean;
  /** The server accepted it; local draft cleanup may still need a retry. Not persisted. */
  confirmed?: boolean;
}

/**
 * How a send ended: the server took the message (all the messages of the reply), refused it (nothing
 * saved, the draft stays), or its answer never came. "blocked": an attempt with an unknown outcome
 * waits for a retry or for being given up first; "invalid": the draft breaks a limit the server would
 * refuse (said, nothing sent); "stopped": the operator stopped a reply's files part way; "skipped":
 * nothing to send or another send runs.
 */
export type SendOutcome = "accepted" | "rejected" | "unknown" | "blocked" | "invalid" | "stopped" | "skipped";

/**
 * A reply with several files on its way, or stopped part way, as the reply box tells it. `accepted`
 * counts the messages the server took (not delivered to the customer: the history shows that).
 */
export interface SendProgress {
  project: string;
  ticket: string;
  total: number;
  accepted: number;
  state: "running" | "stopping" | "stopped";
  /** The file whose send did not end with the server taking it. */
  stoppedAt: string | null;
}

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
  /** The open dialogue's folder change: running, its last word and whether that word is a failure. */
  const folderMove = reactive({ busy: false, status: "", failed: false });
  const change = ref<{ kind: HistoryChange; count: number }>({ kind: "initial", count: 0 });
  /** Address of the image shown in the viewer; closed with the dialogue. */
  const viewer = ref<string | null>(null);
  const drafts = reactive(new Map<string, Draft>());
  /** Attempts with an unknown outcome (or still running), by project and dialogue; they outlive a project switch. */
  const attempts = reactive(new Map<string, SendAttempt>());
  const cache = new Map<string, Snapshot>();
  /** The revision of each stored draft this tab last read or wrote, by `account/project/ticket`. */
  const draftRevs = new Map<string, string>();
  /** Text edits waiting to be written, by `account/project/ticket`. */
  const pendingSaves = new Map<string, { timer: ReturnType<typeof setTimeout>; write: () => void }>();
  /** Files the storage could not keep (no room, a browser that keeps no files): the text is kept, these are not. */
  const fileless = new Map<string, Set<File>>();
  /** The ids of the files whose bytes each stored draft holds, as this tab wrote them: they are not written again. */
  const storedFiles = new Map<string, Set<string>>();
  /** A reply with several files on its way or stopped part way (one at a time: a send holds the dialogue). */
  const progress = ref<SendProgress | null>(null);
  /** The draft's file whose attempt is being made or sent now: it cannot be removed meanwhile. */
  const inFlight = shallowRef<File | null>(null);
  /** Each draft's writes, one after another: a file's bytes take time to read, the order must hold. */
  const writing = new Map<string, Promise<void>>();
  /**
   * Edits not yet confirmed by the storage, by `account/project/ticket`. A write started as the page is
   * left may never finish (WebKit drops it): their texts stay in the tab for its next load.
   */
  const unsaved = new Map<string, { scope: WorkScope; draft: Draft; at: number; edit: number }>();
  let edits = 0;
  /** The texts the page was left with before a reload, merged into the storage once per sign-in. */
  let leftovers: Promise<void> | null = null;
  let storageWarned = false;
  /** The page is being left (a reload, the tab closing): a request it cuts off keeps its stored state. */
  let leaving = false;
  let epoch = 0;
  let signedIn = 0;
  let detailRequest = 0;
  let messageRequest = 0;
  let historyUpdatedAt = 0;
  let openController: AbortController | null = null;
  /** Read receipts by `project/ticket`: confirmed by the server, on their way, and the last that failed. */
  const readMarks = new Map<string, Message>();
  const reading = new Map<string, Message>();
  const readFailed = new Map<string, { id: string; at: number }>();
  /**
   * "To the latest message" asked for a dialogue (a double-click on its row, or its row on a phone
   * where the list covered it). components/chat/MessageList.vue does it once that dialogue's current
   * history is loaded and shown; opening another dialogue drops it.
   */
  const jump = ref<{ ticket: string } | null>(null);

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
  const scopeOf = (projectId: string, id: string): WorkScope | null => {
    const owner = session.account?.id;
    return owner ? { account: owner, project: projectId, ticket: id } : null;
  };
  const scopeName = (scope: WorkScope): string => `${scope.account}/${scope.project}/${scope.ticket}`;

  /** The storage refused: said once, the work stays in memory. Another tab's draft is never touched. */
  function storageFailed(error: unknown): void {
    if (storageWarned) return;
    storageWarned = true;
    workspace().show(error instanceof StorageError && error.problem !== "unavailable"
      ? `${error.message} Черновики и отправки после обновления страницы могут пропасть.`
      : STORAGE_OFF);
  }

  /** Runs a draft's storage job after the ones before it: a file's bytes take time to read, the order must hold. */
  function enqueue(name: string, job: () => Promise<void>): Promise<void> {
    const next = (writing.get(name) ?? Promise.resolve()).then(job);
    // Background flushes and later edits must remain usable after a failed checkpoint.
    // Only the checkpoint's caller receives the failure and keeps the recovery key.
    const tracked = next.catch(() => undefined);
    writing.set(name, tracked);
    const tidy = (): void => {
      if (writing.get(name) === tracked) writing.delete(name);
    };
    void next.then(tidy, tidy);
    return next;
  }

  /** Writes the draft as it is now. A file the storage cannot keep leaves its name, to be attached again. */
  function storeDraft(scope: WorkScope, current: Draft, checkpoint = false): Promise<void> {
    const name = scopeName(scope);
    // A write that ends after a sign-out says nothing: its notices belong to the session gone.
    const at = signedIn;
    const notify = (text: string): void => {
      if (at === signedIn) workspace().show(text);
    };
    const failed = (error: unknown): void => {
      if (at === signedIn) storageFailed(error);
    };
    let tried: File[] = [];
    // The draft is read when its turn comes: the write holds the latest text and files.
    const write = async (): Promise<void> => {
      const lost = fileless.get(name) ?? new Set<File>();
      for (const file of lost) if (!current.files.includes(file)) lost.delete(file);
      const files = current.files.filter((file) => !lost.has(file));
      const edit = unsaved.get(name)?.edit;
      const stored = storedFiles.get(name) ?? new Set<string>();
      tried = files.filter((file) => !stored.has(fileId(file)));
      const put = new Map<string, ArrayBuffer>();
      for (const file of tried) put.set(fileId(file), await fileBytes(file));
      const kept = new Set(files.map(fileId));
      const record: StoredDraft = {
        v: DRAFT_VERSION, ...scope, text: current.text, files: files.map((file) => ({ id: fileId(file), file })),
        lostFiles: current.files.filter((file) => lost.has(file)).map((file) => file.name),
        rev: crypto.randomUUID(), tab: TAB, updatedAt: Date.now(),
      };
      const drop = [...stored].filter((id) => !kept.has(id));
      const { conflict, refile } = await writeDraft(record, draftRevs.get(name) ?? null, { put, drop });
      draftRevs.set(name, record.rev);
      if (edit !== undefined && unsaved.get(name)?.edit === edit) unsaved.delete(name);
      storedFiles.set(name, refile ? new Set(put.keys()) : kept);
      if (conflict) notify(DRAFT_CONFLICT);
      if (refile) void storeDraft(scope, current);
    };
    return enqueue(name, async () => {
      try {
        await write();
      } catch (error) {
        // An accepted send must keep its recovery key until this exact cleanup succeeds.
        if (checkpoint) throw error;
        // The files this write tried, not ones attached since.
        const files = tried;
        if (!files.length || (error instanceof StorageError && error.problem === "unavailable")) {
          failed(error);
          return;
        }
        // No room, or a browser that keeps no files (WebKit in a private window): the text and the files
        // stored before are kept, these are named, to be attached again after a reload.
        const lost = fileless.get(name) ?? new Set<File>();
        for (const file of files) lost.add(file);
        fileless.set(name, lost);
        notify(lostFile(files.map((file) => file.name)));
        await write().catch(failed);
      }
    });
  }

  /**
   * Schedules the write of a dialogue's draft: text edits wait a little, anything else goes at once.
   * Every write starts a new transaction, and the browser runs them in that order: an older text
   * never lands over a newer one.
   */
  function queueDraft(id: string, delay: number, checkpoint = false): Promise<void> {
    const projectId = project();
    const current = drafts.get(id);
    const scope = projectId ? scopeOf(projectId, id) : null;
    if (!scope || !current) return Promise.resolve();
    const name = scopeName(scope);
    unsaved.set(name, { scope, draft: current, at: Date.now(), edit: ++edits });
    let written = Promise.resolve();
    const write = (): void => {
      pendingSaves.delete(name);
      written = storeDraft(scope, current, checkpoint);
    };
    clearTimeout(pendingSaves.get(name)?.timer);
    if (delay <= 0) write();
    else pendingSaves.set(name, { timer: setTimeout(write, delay), write });
    // A write made at once resolves when it has landed (or failed).
    return written;
  }

  /**
   * Writes every waiting edit now: before leaving a dialogue or project, and when the tab is hidden or
   * closes. Resolves once every draft write this tab has started has landed (or failed).
   */
  function flushDrafts(): Promise<void> {
    for (const pending of [...pendingSaves.values()]) {
      clearTimeout(pending.timer);
      pending.write();
    }
    return Promise.all([...writing.values()]).then(() => undefined);
  }

  /**
   * A draft that has just been sent: a waiting write must not bring its text back. Another tab's draft
   * written since, with other content, stays.
   */
  function dropDraft(scope: WorkScope, sent: Draft, checkpoint = false): Promise<void> {
    const name = scopeName(scope);
    clearTimeout(pendingSaves.get(name)?.timer);
    pendingSaves.delete(name);
    fileless.delete(name);
    unsaved.delete(name);
    // After any write already on its way: the removal comes last.
    return enqueue(name, async () => {
      try {
        if (await removeDraft(scope, draftRevs.get(name) ?? null, sent)) {
          draftRevs.delete(name);
          storedFiles.delete(name);
        }
      } catch (error) {
        if (checkpoint) throw error;
        storageFailed(error);
      }
    });
  }

  const toRecord = (scope: WorkScope, pending: SendAttempt): StoredAttempt => ({
    v: 1, ...scope, key: pending.key, text: pending.text, file: pending.file, state: pending.state,
    reason: pending.reason, tries: pending.tries, createdAt: pending.createdAt, draftFileId: pending.draftFileId,
  });

  /**
   * A stored attempt back in memory: whatever it was doing, its outcome is unknown now. Its record is
   * written before the first request, so that request may have gone out: a refusal of the next one
   * proves nothing (at least one try is counted).
   */
  const fromRecord = (record: StoredAttempt): SendAttempt => ({
    key: record.key, project: record.project, ticket: record.ticket, text: record.text, file: record.file,
    state: "unknown", reason: record.state === "sending" ? ATTEMPT_RELOADED : record.reason, tries: Math.max(record.tries, 1),
    createdAt: record.createdAt, persisted: true, draftFileId: record.draftFileId,
  });

  /** Follows the attempt's state in the storage; a lost update only leaves it "unknown" after a reload. */
  function storeAttempt(pending: SendAttempt): void {
    const scope = scopeOf(pending.project, pending.ticket);
    if (scope && pending.persisted) void updateAttempt(toRecord(scope, pending)).catch(storageFailed);
  }

  function dropAttempt(pending: SendAttempt): Promise<void> {
    const scope = scopeOf(pending.project, pending.ticket);
    return scope && pending.persisted ? removeAttempt(scope, pending.key).catch(storageFailed) : Promise.resolve();
  }

  /** A dialogue's stored draft and attempt, read when it is first opened in this project. */
  async function loadWork(id: string, projectId: string): Promise<void> {
    const at = signedIn;
    const scope = scopeOf(projectId, id);
    const read = async (): Promise<[StoredDraft | null, StoredAttempt | null]> => {
      if (!scope) return [null, null];
      // Texts left by the page before a reload, then this tab's own writes of the draft (one may have
      // been flushed by a project switch) land first: the read sees the latest of them.
      leftovers ??= Promise.all(takeUnsaved(scope.account).map((left) => restoreDraft(left, TAB).catch(() => undefined)))
        .then(() => undefined);
      await leftovers;
      const name = scopeName(scope);
      for (let pending = writing.get(name); pending; pending = writing.get(name)) await pending;
      return Promise.all([
        readDraft(scope).catch((error: unknown) => { storageFailed(error); return null; }),
        readAttempt(scope).catch((error: unknown) => { storageFailed(error); return null; }),
      ]);
    };
    // The reply box waits for the storage, not for ever: one that does not answer leaves it empty.
    const [stored, kept] = await patience(read()).catch((error: unknown): [null, null] => {
      storageFailed(error);
      return [null, null];
    });
    if (at !== signedIn || project() !== projectId) return;
    if (!drafts.has(id)) {
      const files = (stored?.files ?? []).map((item) => {
        fileIds.set(item.file, item.id);
        return item.file;
      });
      drafts.set(id, { text: stored?.text ?? "", files });
      if (stored && scope) {
        draftRevs.set(scopeName(scope), stored.rev);
        storedFiles.set(scopeName(scope), new Set(stored.files.map((item) => item.id)));
      }
      if (stored?.lostFiles.length && ticketId.value === id) workspace().show(lostAfterReload(stored.lostFiles));
    }
    if (kept && !attempts.has(slot(projectId, id))) {
      attempts.set(slot(projectId, id), fromRecord(kept));
      if (ticketId.value === id) await settleFromHistory();
    }
  }

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
    void flushDrafts();
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
    folderMove.failed = false;
    viewer.value = null;
    if (jump.value?.ticket !== id) jump.value = null;
    // Until the stored draft is read the reply box waits: it never shows empty and then fills.
    const projectId = project();
    if (!drafts.has(id) && projectId) void loadWork(id, projectId);
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
    await settleFromHistory();
  }

  /**
   * A message the console sent carries its key: an attempt with an unknown outcome whose message the
   * history shows was taken after all. Checked after every history load and after an attempt is read
   * back from the storage, whichever comes last.
   */
  async function settleFromHistory(): Promise<void> {
    const pending = attempt.value;
    if (pending?.state === "unknown" && [...messages.value.values()].some((item) => item.command === pending.key)) {
      const generation = session.generation;
      const settled = await accepted(pending);
      if (settled && generation === session.generation) workspace().show(SEND_FOUND);
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

  /**
   * Tells the server the operator has seen the open dialogue up to `messageId`: its latest message,
   * in view (components/chat/MessageList.vue decides that). Sent once per message and never for one
   * that is not newer than a receipt confirmed or on its way: the server only moves the position
   * forward. A failed receipt waits a little before it is tried again. Once the server confirms one,
   * the dialogue list is synced at once: the unread counts come from the server, with whatever
   * arrived meanwhile, instead of waiting for the next poll.
   */
  function markRead(messageId: string): void {
    const id = ticketId.value;
    const projectId = project();
    const message = messages.value.get(messageId);
    if (!id || !projectId || !message) return;
    const key = slot(projectId, id);
    for (const known of [readMarks.get(key), reading.get(key)]) {
      if (known && byTime(message, known) <= 0) return;
    }
    const failed = readFailed.get(key);
    if (failed?.id === messageId && Date.now() - failed.at < READ_RETRY_DELAY) return;
    reading.set(key, message);
    const at = signedIn;
    session.api(`tickets/${id}/read/${messageId}`, { method: "POST" }, projectId).then(() => {
      if (at !== signedIn) return;
      if (reading.get(key) === message) reading.delete(key);
      if (readFailed.get(key)?.id === messageId) readFailed.delete(key);
      const confirmed = readMarks.get(key);
      if (!confirmed || byTime(message, confirmed) > 0) readMarks.set(key, message);
      // A list that fails to reload now is reported by the next live refresh.
      if (project() === projectId) useTicketsStore().sync().catch(() => undefined);
    }, (error: unknown) => {
      if (at !== signedIn) return;
      if (reading.get(key) === message) reading.delete(key);
      readFailed.set(key, { id: messageId, at: Date.now() });
      if (ticketId.value === id && project() === projectId) workspace().fail(error);
    });
  }

  /** Asks for the latest message of the open (or opening) dialogue; another dialogue's request is ignored. */
  function jumpToLatest(id: string): void {
    if (ticketId.value === id) jump.value = { ticket: id };
  }

  /**
   * Attaches files after the draft's own, as one pick, drop or paste. Each is checked as the server
   * would check it (lib/attachment.ts), and a reply takes MAX_FILES at most: the files refused are
   * named with their reasons, the others are attached all the same, in the order given. The same file
   * object again (a repeated event) is taken once; two files of the same name are two files. Returns
   * how many were attached.
   */
  function attach(files: File[]): number {
    const current = draft.value;
    const id = ticketId.value;
    if (!current || !id || !files.length) return 0;
    const added: File[] = [];
    const refused: { name: string; problem: string }[] = [];
    for (const file of files) {
      if (current.files.includes(file) || added.includes(file)) continue;
      const problem = fileProblem(file) ?? (current.files.length + added.length >= MAX_FILES ? FILES_LIMIT : null);
      if (problem) refused.push({ name: file.name, problem });
      else added.push(file);
    }
    if (added.length) {
      current.files.push(...added);
      void queueDraft(id, 0);
    }
    if (refused.length) workspace().show(refusal(refused, files.length));
    return added.length;
  }

  /**
   * Removes a file from the open dialogue's draft. While a reply's files go, the ones still waiting can
   * be removed (they are not sent then); the one on its way cannot.
   */
  function detach(file: File): void {
    const current = draft.value;
    const id = ticketId.value;
    const queued = progress.value?.state === "running" || progress.value?.state === "stopping";
    if (!current || !id || (sending.value && !queued) || file === inFlight.value) return;
    const index = current.files.indexOf(file);
    if (index < 0) return;
    current.files.splice(index, 1);
    void queueDraft(id, 0);
    // A waiting file removed is no longer part of the reply; a reply stopped part way with nothing left is over.
    const shown = progress.value;
    if (shown?.ticket === id && shown.project === project()) {
      if (queued) shown.total--;
      else if (shown.state === "stopped" && !current.files.length) progress.value = null;
    }
  }

  function edit(text: string): void {
    const current = draft.value;
    if (!current || !ticketId.value) return;
    current.text = text;
    void queueDraft(ticketId.value, DRAFT_SAVE_DELAY);
  }

  /** Why the draft cannot go as it is (said before anything is sent), or null. */
  function draftProblem(current: Draft): string | null {
    if (current.files.length > MAX_FILES) return `${FILES_LIMIT} Уберите лишние.`;
    for (const file of current.files) {
      const problem = fileProblem(file);
      if (problem) return current.files.length > 1 ? `${quoted(file.name)}: ${problem}` : problem;
    }
    return textProblem(current.text, current.files.length > 0);
  }

  /**
   * Sends the open dialogue's draft (see run). An attempt whose outcome is unknown comes first: a draft
   * that begins with the same text and file sends it once more under its key, then the rest; anything
   * else waits for it.
   */
  async function send(): Promise<SendOutcome> {
    const generation = session.generation;
    const id = ticketId.value;
    const projectId = project();
    const current = draft.value;
    if (!id || !projectId || !current || sending.value) return "skipped";
    const pending = attempts.get(slot(projectId, id));
    if (pending) {
      const text = current.text;
      const head = current.files[0] ?? null;
      sending.value = true;
      const matches = pending.text === text
        && (!pending.draftFileId || (head !== null && fileId(head) === pending.draftFileId))
        && await sameFile(pending.file, head);
      if (generation !== session.generation) return "skipped";
      sending.value = false;
      if (attempts.get(slot(projectId, id)) !== pending || draft.value !== current || project() !== projectId) return "skipped";
      if (!matches || current.text !== text || (current.files[0] ?? null) !== head) {
        workspace().show(SEND_BLOCKED);
        return "blocked";
      }
    } else if (!textLength(current.text) && !current.files.length) {
      return "skipped";
    }
    // Said before anything is sent: the draft stays as it is, to be fixed.
    const problem = draftProblem(current);
    if (problem) {
      workspace().show(problem);
      return "invalid";
    }
    workspace().show();
    return run(current, pending ?? null);
  }

  /**
   * Sends a draft: its text alone, or its files one after another, each an attempt and a message of
   * its own, the text as the first one's caption. `first` is the attempt with an unknown outcome the
   * draft begins with: it goes again under its key. A file starts only once the server took the one
   * before and the draft no longer holds it; any other outcome stops the reply, and what is left stays
   * in the draft to be sent again. A file removed meanwhile is not sent; one attached later is not part
   * of this send. The history is refreshed once, at the end.
   */
  async function run(current: Draft, first: SendAttempt | null): Promise<SendOutcome> {
    const generation = session.generation;
    const id = ticketId.value!;
    const projectId = project()!;
    const planned = [...current.files];
    progress.value = planned.length > 1
      ? { project: projectId, ticket: id, total: planned.length, accepted: 0, state: "running", stoppedAt: null }
      : null;
    const shown = progress.value;
    let outcome: SendOutcome = "accepted";
    let taken = 0;
    let file: File | null = null;
    sending.value = true;
    try {
      for (let index = 0; index < Math.max(planned.length, 1); index++) {
        file = planned[index] ?? null;
        if (index > 0) {
          if (shown?.state === "stopping") {
            outcome = "stopped";
            file = null;
            break;
          }
          if (drafts.get(id) !== current || !current.files.includes(file!)) continue;
        }
        inFlight.value = file;
        const pending: SendAttempt | "blocked" | "skipped" = index === 0 && first ? first : await begin(id, projectId, index === 0 ? current.text : "", file);
        if (typeof pending === "string") {
          outcome = pending;
          break;
        }
        const result = await deliver(pending, true);
        if (result !== "accepted") {
          outcome = result;
          break;
        }
        taken++;
        if (generation !== session.generation) return "skipped";
      }
    } finally {
      if (generation === session.generation) {
        inFlight.value = null;
        sending.value = false;
      }
    }
    if (generation !== session.generation || outcome === "skipped") return "skipped";
    if (shown && progress.value === shown) {
      if (outcome === "accepted") {
        progress.value = null;
      } else {
        shown.state = "stopped";
        shown.stoppedAt = file?.name ?? null;
      }
    }
    if (taken) await refreshAfterSend(id, projectId, generation);
    return outcome;
  }

  /** A new attempt, stored in the browser before its first request leaves; or why it does not go. */
  async function begin(id: string, projectId: string, text: string, file: File | null): Promise<SendAttempt | "blocked" | "skipped"> {
    const generation = session.generation;
    attempts.set(slot(projectId, id), {
      key: crypto.randomUUID(), project: projectId, ticket: id, text, file,
      draftFileId: file ? fileId(file) : undefined,
      state: "sending", reason: "", tries: 0, createdAt: Date.now(), persisted: false,
    });
    const fresh = attempts.get(slot(projectId, id))!;
    // The key is stored before the first request leaves: a reload in between keeps it.
    const scope = scopeOf(projectId, id);
    const storing = scope ? createAttempt(toRecord(scope, fresh)) : null;
    try {
      const { existing } = storing ? await patience(storing) : { existing: null };
      if (generation !== session.generation) return "skipped";
      if (existing) {
        // Another tab's attempt waits in this dialogue: it is taken over here instead of a second one.
        attempts.set(slot(projectId, id), fromRecord(existing));
        workspace().show(ATTEMPT_ELSEWHERE);
        return "blocked";
      }
      fresh.persisted = Boolean(scope);
    } catch (error) {
      if (generation !== session.generation) return "skipped";
      // Sent anyway, safe to retry while this page lives; the banner says a reload would lose it, and
      // every such send says it again.
      workspace().show(error instanceof StorageError && error.problem !== "unavailable"
        ? `${error.message} Эта отправка не переживёт обновление страницы.`
        : STORAGE_OFF);
      // A storage that answers late keeps the attempt after all: from then on it follows the attempt,
      // or removes it, once the attempt is over.
      void storing?.then(({ existing }) => {
        if (existing || generation !== session.generation) return;
        fresh.persisted = true;
        if (attempts.get(slot(projectId, id)) === fresh) storeAttempt(fresh);
        else void dropAttempt(fresh);
      }, () => undefined);
    }
    return fresh;
  }

  /** Sends the open dialogue's attempt with an unknown outcome again: its own text, file and key. */
  async function retrySend(): Promise<SendOutcome> {
    const pending = attempt.value;
    if (!pending || sending.value) return "skipped";
    workspace().show();
    return deliver(pending);
  }

  /** Ends a reply's files after the one on its way: the rest stay in the draft. Nothing the server took is recalled. */
  function stopSending(): void {
    if (progress.value?.state === "running") progress.value.state = "stopping";
  }

  /** The operator gives up an attempt with an unknown outcome (for example, seen in Telegram); the draft stays. */
  function forgetAttempt(): void {
    const pending = attempt.value;
    if (pending?.state !== "unknown") return;
    attempts.delete(slot(pending.project, pending.ticket));
    void dropAttempt(pending);
  }

  /**
   * One request of an attempt, bounded by its deadline; one at a time. `queued`: a file of a reply
   * (run), which holds `sending` and refreshes the history itself once its files are done.
   */
  async function deliver(pending: SendAttempt, queued = false): Promise<SendOutcome> {
    const generation = session.generation;
    const form = new FormData();
    form.set("text", pending.text);
    if (pending.file) form.set("file", pending.file);
    const timeout = sendDeadline(pending.file);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), timeout);
    pending.state = "sending";
    pending.tries++;
    sending.value = true;
    storeAttempt(pending);
    try {
      try {
        await session.api(`tickets/${pending.ticket}/send`, {
          method: "POST", form, key: pending.key, signal: controller.signal,
        }, pending.project);
      } catch (error) {
        if (generation !== session.generation) return "skipped";
        if (refused(error) && pending.tries === 1) {
          // Nothing was saved: the attempt is over and the draft is there to be fixed.
          attempts.delete(slot(pending.project, pending.ticket));
          void dropAttempt(pending);
          workspace().fail(error);
          return "rejected";
        }
        pending.state = "unknown";
        const seconds = Math.round(timeout / 1000);
        pending.reason = controller.signal.aborted
          ? `Сервер не ответил за ${seconds >= 120 ? `${Math.round(seconds / 60)} мин` : `${seconds} с`}.`
          : error instanceof Error && error.message ? error.message : FAILED;
        // A reload leaves the stored state as "sending" so it explains the interrupted request.
        if (!leaving) storeAttempt(pending);
        return "unknown";
      }
      if (generation !== session.generation) return "skipped";
      // Keep single-flight protection until the matching draft has been identified and cleared.
      if (!await accepted(pending)) return generation === session.generation ? "unknown" : "skipped";
    } finally {
      clearTimeout(deadline);
      if (!queued && generation === session.generation) sending.value = false;
    }
    if (generation !== session.generation) return "skipped";
    if (!queued) await refreshAfterSend(pending.ticket, pending.project, generation);
    return "accepted";
  }

  /** The messages are saved: a history or list that fails to reload says so, never as a failed send. */
  async function refreshAfterSend(id: string, projectId: string, generation: number): Promise<void> {
    try {
      if (ticketId.value === id && project() === projectId) {
        await syncMessages();
        await useTicketsStore().sync();
        await syncDetail();
      }
    } catch (error) {
      if (generation === session.generation) workspace().show(`${SEND_REFRESH_FAILED}: ${error instanceof Error && error.message ? error.message : FAILED}`);
    }
  }

  /**
   * The server took the attempt: it ends, and what it sent leaves the draft: its file (the same bytes,
   * a copy read back after a reload too), and its text unless edited since. A draft that no longer
   * holds the file keeps its text as well. The attempt's stored record goes after the draft's write: a
   * reload in between brings the attempt back as unknown (the history then settles it), never its
   * file as one still to send.
   */
  async function accepted(pending: SendAttempt): Promise<boolean> {
    const generation = session.generation;
    const key = slot(pending.project, pending.ticket);
    if (attempts.get(key) !== pending) return true;
    // History can settle an attempt too. No new send may start during the file comparison.
    const wasSending = sending.value;
    sending.value = true;
    pending.state = "sending";
    try {
      const current = project() === pending.project ? drafts.get(pending.ticket) : undefined;
      const firstConfirmation = !pending.confirmed;
      let sent: File | null = firstConfirmation && current && pending.file && current.files.includes(pending.file) ? pending.file : null;
      for (const file of firstConfirmation && current && pending.file && !sent ? [...current.files] : []) {
        // Equal files can be separate entries. A late checkpoint may already have removed this
        // entry before a reload; do not consume the next identical file while settling its key.
        if ((!pending.draftFileId || fileId(file) === pending.draftFileId) && await sameFile(file, pending.file)) {
          sent = file;
          break;
        }
      }
      if (generation !== session.generation || attempts.get(key) !== pending) return false;
      pending.confirmed = true;
      let written = Promise.resolve();
      if (current && project() === pending.project && drafts.get(pending.ticket) === current) {
        const before: Draft = { text: current.text, files: [...current.files] };
        const index = sent ? current.files.indexOf(sent) : -1;
        if (firstConfirmation && (!pending.file || index >= 0)) {
          if (index >= 0) current.files.splice(index, 1);
          if (current.text === pending.text) current.text = "";
        }
        const scope = scopeOf(pending.project, pending.ticket);
        if (scope && !current.text && !current.files.length) written = dropDraft(scope, before, pending.persisted);
        // Retry the checkpoint even if a previous failed cleanup already removed the file in memory.
        else if (pending.persisted || current.text !== before.text || current.files.length !== before.files.length) written = queueDraft(pending.ticket, 0, pending.persisted);
      }
      // One more file of a reply sent part way: a reply stopped, then settled, is done once all are taken.
      const shown = progress.value;
      if (firstConfirmation && shown && shown.project === pending.project && shown.ticket === pending.ticket) {
        shown.accepted++;
        if (shown.state === "stopped" && shown.accepted >= shown.total) progress.value = null;
      }
      try {
        await patience(written);
      } catch {
        if (generation !== session.generation || attempts.get(key) !== pending) return false;
        pending.state = "unknown";
        pending.reason = "Сервер принял сообщение, но браузер не подтвердил сохранение черновика. Очередь остановлена. Повторите отправку: повтор использует тот же ключ и не создаст дубликат.";
        storeAttempt(pending);
        return false;
      }
      if (generation !== session.generation || attempts.get(key) !== pending) return false;
      await patience(dropAttempt(pending)).catch(() => undefined);
      if (generation !== session.generation || attempts.get(key) !== pending) return false;
      attempts.delete(key);
      return true;
    } finally {
      if (!wasSending && generation === session.generation) sending.value = false;
    }
  }

  /**
   * Leaves the open dialogue for the list; its draft stays (a dialogue restored after a reload that is
   * gone or no longer allowed).
   */
  function close(): void {
    void flushDrafts();
    epoch++;
    openController?.abort();
    openController = null;
    ticketId.value = null;
    detail.value = null;
    heading.value = {};
    messages.value = new Map();
    opening.value = false;
    unavailable.value = false;
    viewer.value = null;
    jump.value = null;
    touched("initial");
    workspace().dialogueOpen = false;
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
    folderMove.failed = false;
    try {
      await session.api<FolderAssignment>(`tickets/${id}/folder`, {
        method: "POST", data: { folder_id: folderId, revision },
      }, currentProject);
      if (at === epoch) folderMove.status = "Сохранено для команды";
    } catch (error) {
      if (at === epoch) {
        folderMove.status = error instanceof Error ? error.message : "Не удалось перенести диалог.";
        folderMove.failed = true;
      }
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

  /**
   * For another project or after sign-out: nothing of the dialogue, its drafts or caches remains in
   * memory. Waiting draft writes go to the storage first: the drafts come back with their dialogues.
   */
  function reset(): void {
    void flushDrafts();
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
    folderMove.failed = false;
    viewer.value = null;
    inFlight.value = null;
    drafts.clear();
    cache.clear();
    historyUpdatedAt = 0;
    jump.value = null;
    touched("initial");
  }
  // Attempts outlive a project switch (reset), not the session: another account may sign in. Their
  // stored copies stay with the account (an explicit sign-out removes them, see AccountMenu).
  session.onSessionEnd(() => {
    void flushDrafts();
    signedIn++;
    reset();
    attempts.clear();
    progress.value = null;
    draftRevs.clear();
    fileless.clear();
    storedFiles.clear();
    unsaved.clear();
    leftovers = null;
    storageWarned = false;
    readMarks.clear();
    reading.clear();
    readFailed.clear();
  });
  // The browser may end the page at any time after it is hidden: waiting edits are written then.
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void flushDrafts();
    });
    window.addEventListener("pagehide", () => {
      leaving = true;
      void flushDrafts();
      keepUnsaved([...unsaved.values()].map(({ scope, draft, at }) => ({ ...scope, text: draft.text, at })));
    });
    window.addEventListener("pageshow", (event) => {
      leaving = false;
      // Back from the back/forward cache: the page goes on with its own state, the kept texts are stale.
      if (event.persisted) keepUnsaved([]);
    });
    // Firefox and WebKit end the page's requests as soon as a reload starts, before "pagehide". While a
    // send runs, "beforeunload" marks the page as being left; only then, as Firefox keeps no page with
    // that listener in its back/forward cache. A page that stays (a download) is unmarked when the send ends.
    const markLeaving = (): void => {
      leaving = true;
    };
    watch(sending, (value) => {
      if (value) {
        window.addEventListener("beforeunload", markLeaving);
      } else {
        window.removeEventListener("beforeunload", markLeaving);
        leaving = false;
      }
    });
  }

  return {
    ticketId, detail, heading, messages, ordered, before, hasOlder, loadingOlder, opening, sending,
    lifecycleBusy, unavailable, folderMove, change, viewer, drafts, draft, attempts, attempt, closed, jump,
    progress, inFlight,
    open, close, syncDetail, syncMessages, loadOlder, markRead, jumpToLatest, attach, detach, edit, send, retrySend, stopSending,
    forgetAttempt, retry, toggleClosed, moveToFolder, flushDrafts, reset,
  };
});
