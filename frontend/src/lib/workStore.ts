// The operator's unsent work kept in the browser (IndexedDB), per account, project and dialogue:
// drafts (text and one file) and send attempts whose outcome is not known yet. Nothing of the
// conversation itself is stored, and nothing is read before the session check named the account.
// Files are kept as their bytes (an ArrayBuffer with name, type and date): WebKit keeps no Blobs in
// IndexedDB in private windows. A draft's file has a store of its own, written only when the file
// changes, not with every edit of the text. Every failure becomes a StorageError the caller can
// explain; nothing here deletes work on its own, except records too damaged to be used.

export const WORK_DB = "resolvate-work";
const DB_VERSION = 1;
/** The shape of the stored records; a record of another version is skipped. */
export const RECORD_VERSION = 1;

/** Which dialogue a record belongs to. */
export interface WorkScope {
  account: string;
  project: string;
  ticket: string;
}

export interface StoredDraft extends WorkScope {
  v: typeof RECORD_VERSION;
  text: string;
  file: File | null;
  /** The name of a file that could not be stored or read back: it has to be attached again. */
  lostFile: string | null;
  /** Changes with every write: a tab that did not write the current revision knows another one did. */
  rev: string;
  tab: string;
  updatedAt: number;
}

export interface StoredAttempt extends WorkScope {
  v: typeof RECORD_VERSION;
  key: string;
  text: string;
  file: File | null;
  state: "sending" | "unknown";
  reason: string;
  tries: number;
  createdAt: number;
}

/** What a draft write does with the draft's file: keeps the stored one, stores new bytes, or removes it. */
export type FileChange = "same" | { bytes: ArrayBuffer } | null;

export type StorageProblem = "unavailable" | "quota" | "failed";

export class StorageError extends Error {
  constructor(readonly problem: StorageProblem, message: string) {
    super(message);
    this.name = "StorageError";
  }
}

/** Opening the database waits this long: a browser that never answers counts as one without storage. */
const OPEN_TIMEOUT = 3_000;
/** How long the operator waits for the storage: opening a dialogue, sending, signing out. */
export const STORAGE_PATIENCE = 3_000;

const DRAFTS = "drafts";
const FILES = "files";
const ATTEMPTS = "attempts";
const KEY_PATH = ["account", "project", "ticket"];

/** A file's description next to the draft; its bytes live in FILES under the same key. */
interface FileInfo {
  name: string;
  type: string;
  size: number;
  lastModified: number;
}
interface PackedFile extends FileInfo {
  bytes: ArrayBuffer;
}
type DraftRow = Omit<StoredDraft, "file"> & { file: FileInfo | null };
type FileRow = WorkScope & PackedFile;
type AttemptRow = Omit<StoredAttempt, "file"> & { file: PackedFile | null };

const scopeKey = ({ account, project, ticket }: WorkScope): IDBValidKey => [account, project, ticket];
const scopeOf = ({ account, project, ticket }: WorkScope): WorkScope => ({ account, project, ticket });
/** Every key of one account: arrays sort after strings, so [account, []] closes the range. */
const accountRange = (account: string): IDBKeyRange => IDBKeyRange.bound([account], [account, []]);

function problemOf(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "QuotaExceededError") return new StorageError("quota", "В браузере не хватает места.");
  if (name === "SecurityError" || name === "InvalidStateError") {
    return new StorageError("unavailable", "Браузер не даёт сохранять данные на этом устройстве.");
  }
  return new StorageError("failed", "Не удалось сохранить данные в браузере.");
}

const info = (file: File): FileInfo => ({ name: file.name, type: file.type, size: file.size, lastModified: file.lastModified });
/** One file described twice (a draft's row and its bytes, or a file and its copy read back). */
const sameInfo = (a: FileInfo | null, b: FileInfo | null): boolean =>
  a === b || (a !== null && b !== null && a.name === b.name && a.type === b.type && a.size === b.size && a.lastModified === b.lastModified);
const unpack = (file: PackedFile): File => new File([file.bytes], file.name, { type: file.type, lastModified: file.lastModified });

/** A file's bytes, read before a transaction starts (a transaction cannot wait for them). */
export async function fileBytes(file: File): Promise<ArrayBuffer> {
  try {
    return await file.arrayBuffer();
  } catch {
    throw new StorageError("failed", "Не удалось прочитать файл для сохранения в браузере.");
  }
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const other = new Uint8Array(b);
  return new Uint8Array(a).every((byte, index) => byte === other[index]);
}

/** Metadata alone cannot identify content, including copies restored after a reload. */
export async function sameFile(a: File | null, b: File | null): Promise<boolean> {
  if (a === b) return true;
  if (!a || !b || !sameInfo(info(a), info(b))) return false;
  try {
    const [left, right] = await patience(Promise.all([fileBytes(a), fileBytes(b)]));
    return sameBytes(left, right);
  } catch {
    // Unreadable files are not proven equal: keep the draft instead of discarding it.
    return false;
  }
}

let opening: Promise<IDBDatabase> | null = null;

/** The database, opened once; it rejects with StorageError when the browser keeps no storage. */
export function openWork(): Promise<IDBDatabase> {
  if (opening) return opening;
  const forget = (): void => {
    if (opening === current) opening = null;
  };
  const current = new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === "undefined") throw new StorageError("unavailable", "Браузер не поддерживает локальное хранение.");
      request = indexedDB.open(WORK_DB, DB_VERSION);
    } catch (error) {
      reject(problemOf(error));
      return;
    }
    let given = false;
    const giveUp = (error: StorageError): void => {
      given = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => giveUp(new StorageError("unavailable", "Хранилище браузера не отвечает.")), OPEN_TIMEOUT);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of [DRAFTS, FILES, ATTEMPTS]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: KEY_PATH });
      }
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      const db = request.result;
      // Too late: this call has failed already, the next one opens anew.
      if (given) {
        db.close();
        return;
      }
      // Another tab upgrading the schema, or the browser closing the connection (site data cleared):
      // the next call opens it again.
      db.onversionchange = () => {
        db.close();
        forget();
      };
      db.onclose = forget;
      resolve(db);
    };
    request.onerror = () => giveUp(problemOf(request.error));
    request.onblocked = () => giveUp(new StorageError("unavailable", "Локальное хранилище занято другой вкладкой."));
  });
  opening = current;
  current.catch(forget);
  return current;
}

/** Closes the database; the next call opens it again (tests start each from an empty one). */
export async function closeWork(): Promise<void> {
  const current = opening;
  opening = null;
  if (current) (await current.catch(() => null))?.close();
}

/**
 * One transaction: `body` queues the requests, the promise settles once the browser committed them
 * (or failed). Read-write transactions over the same stores run in the order they were created, so a
 * later write never ends up under an earlier one. Attempts use strict durability where the browser
 * offers it.
 */
async function transact<T>(
  stores: string[],
  mode: IDBTransactionMode,
  body: (transaction: IDBTransaction) => T | Promise<T>,
  strict = false,
): Promise<T> {
  const db = await openWork();
  return new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = strict ? db.transaction(stores, mode, { durability: "strict" }) : db.transaction(stores, mode);
    } catch (error) {
      reject(problemOf(error));
      return;
    }
    let result: T;
    let failed: unknown = null;
    transaction.oncomplete = () => (failed ? reject(problemOf(failed)) : resolve(result));
    // A failed request (no room, say) carries its error; the transaction gets one only as it aborts.
    transaction.onerror = (event) => reject(problemOf(failed ?? (event.target as IDBRequest | null)?.error ?? transaction.error));
    transaction.onabort = () => reject(problemOf(failed ?? transaction.error));
    Promise.resolve()
      .then(() => body(transaction))
      .then((value) => { result = value; }, (error: unknown) => {
        failed = error;
        try { transaction.abort(); } catch { /* already finished */ }
      });
  });
}

/**
 * The storage's answer, or a StorageError once the operator has waited long enough. The work itself is
 * not stopped: the caller decides what a late answer means.
 */
export function patience<T>(work: Promise<T>, ms = STORAGE_PATIENCE): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StorageError("failed", "Хранилище браузера не отвечает.")), ms);
    work.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** A request inside a transaction, as a promise. */
function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const text = (value: unknown): value is string => typeof value === "string";
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function validInfo(value: unknown): value is FileInfo {
  const file = value as FileInfo | null;
  return Boolean(file) && text(file!.name) && text(file!.type) && number(file!.size) && number(file!.lastModified);
}

function validPacked(value: unknown): value is PackedFile {
  return validInfo(value) && (value as PackedFile).bytes instanceof ArrayBuffer;
}

function validDraft(value: unknown): value is DraftRow {
  const row = value as DraftRow | null;
  return Boolean(row) && row!.v === RECORD_VERSION && text(row!.text) && (row!.file === null || validInfo(row!.file))
    && (row!.lostFile === null || text(row!.lostFile)) && text(row!.rev) && text(row!.tab) && number(row!.updatedAt);
}

function validAttempt(value: unknown): value is AttemptRow {
  const row = value as AttemptRow | null;
  return Boolean(row) && row!.v === RECORD_VERSION && text(row!.key) && text(row!.text) && (row!.file === null || validPacked(row!.file))
    && (row!.state === "sending" || row!.state === "unknown") && text(row!.reason) && number(row!.tries) && number(row!.createdAt);
}

/** The dialogue's draft, or null; a damaged record is removed, a file that cannot be read back is named. */
export async function readDraft(scope: WorkScope): Promise<StoredDraft | null> {
  return transact([DRAFTS, FILES], "readwrite", async (transaction) => {
    const drafts = transaction.objectStore(DRAFTS);
    const files = transaction.objectStore(FILES);
    const row = await done(drafts.get(scopeKey(scope)));
    if (row === undefined) return null;
    if (!validDraft(row)) {
      drafts.delete(scopeKey(scope));
      files.delete(scopeKey(scope));
      return null;
    }
    let file: File | null = null;
    let lostFile = row.lostFile;
    if (row.file) {
      // Another tab may have stored its own file meanwhile: only the bytes of this very file count.
      const bytes = await done(files.get(scopeKey(scope)));
      if (validPacked(bytes) && sameInfo(bytes, row.file)) file = unpack(bytes);
      else lostFile = row.file.name;
    }
    return { ...row, file, lostFile };
  });
}

/**
 * Writes the draft (an empty one is removed instead) and, per `change`, its file. `known` is the
 * revision this tab last read or wrote: when the stored one differs and came from another tab, the
 * write still happens (the latest edit wins) and `conflict` tells the caller so it can say so.
 * "same" keeps the stored bytes, which are this draft's only over this tab's own last write: otherwise
 * `refile` asks for a write with the file's bytes (until then a read names the file as lost).
 */
export async function writeDraft(
  draft: StoredDraft,
  known: string | null,
  change: FileChange,
): Promise<{ conflict: boolean; refile: boolean }> {
  return transact([DRAFTS, FILES], "readwrite", (transaction) => {
    const drafts = transaction.objectStore(DRAFTS);
    const files = transaction.objectStore(FILES);
    const key = scopeKey(draft);
    // The read and the writes are queued at once and the transaction is committed: nothing waits for a
    // callback, so a write started while the page unloads still reaches the browser whole. Requests
    // run in order: the read sees the draft as it was before.
    const before = done(drafts.get(key));
    before.catch(() => undefined); // An aborted write rejects through the transaction instead.
    if (!draft.text && !draft.file && !draft.lostFile) {
      drafts.delete(key);
      files.delete(key);
    } else {
      drafts.put({ ...draft, file: draft.file ? info(draft.file) : null } satisfies DraftRow);
      if (change === null || !draft.file) files.delete(key);
      else if (change !== "same") files.put({ ...scopeOf(draft), ...info(draft.file), bytes: change.bytes } satisfies FileRow);
    }
    transaction.commit();
    return before.then((current) => {
      const valid = validDraft(current);
      const ours = valid && current.rev === known;
      const file = draft.file ? info(draft.file) : null;
      return {
        conflict: valid && !ours && current.tab !== draft.tab && (current.text !== draft.text || !sameInfo(current.file, file)),
        refile: change === "same" && file !== null && !ours,
      };
    });
  });
}

/**
 * A draft's text the page was left with before its write landed (kept in the tab, lib/navigation.ts):
 * written unless the stored draft is newer. The stored file stays; no text and no file remove the draft.
 */
export async function restoreDraft(left: WorkScope & { text: string; at: number }, tab: string): Promise<void> {
  await transact([DRAFTS, FILES], "readwrite", async (transaction) => {
    const drafts = transaction.objectStore(DRAFTS);
    const files = transaction.objectStore(FILES);
    const current = await done(drafts.get(scopeKey(left)));
    const valid = validDraft(current);
    if (valid && current.updatedAt >= left.at) return;
    const file = valid ? current.file : null;
    const lostFile = valid ? current.lostFile : null;
    if (!valid) files.delete(scopeKey(left));
    if (!left.text && !file && !lostFile) {
      drafts.delete(scopeKey(left));
      return;
    }
    drafts.put({
      v: RECORD_VERSION, ...scopeOf(left), text: left.text, file, lostFile, rev: crypto.randomUUID(), tab, updatedAt: left.at,
    } satisfies DraftRow);
  });
}

/**
 * Removes the draft whose content was sent. A draft another tab wrote since this tab last saw it
 * (`known`), with other content, stays: it is not what was sent. True when no draft is left.
 */
export async function removeDraft(scope: WorkScope, known: string | null, sent: { text: string; file: File | null }): Promise<boolean> {
  // Read outside the transaction: IndexedDB cannot stay alive waiting for File.arrayBuffer().
  const bytes = sent.file ? await fileBytes(sent.file) : null;
  return transact([DRAFTS, FILES], "readwrite", async (transaction) => {
    const drafts = transaction.objectStore(DRAFTS);
    const current = await done(drafts.get(scopeKey(scope)));
    if (current === undefined) return true;
    if (validDraft(current) && current.rev !== known) {
      if (current.text !== sent.text || !sameInfo(current.file, sent.file ? info(sent.file) : null)) return false;
      if (bytes) {
        const stored = await done(transaction.objectStore(FILES).get(scopeKey(scope)));
        if (!validPacked(stored) || !sameBytes(stored.bytes, bytes)) return false;
      }
    }
    drafts.delete(scopeKey(scope));
    transaction.objectStore(FILES).delete(scopeKey(scope));
    return true;
  });
}

const attemptOf = (row: AttemptRow): StoredAttempt => ({ ...row, file: row.file ? unpack(row.file) : null });

/** The dialogue's attempt with an unknown outcome, or null; a damaged record is removed. */
export async function readAttempt(scope: WorkScope): Promise<StoredAttempt | null> {
  return transact([ATTEMPTS], "readwrite", async (transaction) => {
    const store = transaction.objectStore(ATTEMPTS);
    const row = await done(store.get(scopeKey(scope)));
    if (row === undefined) return null;
    if (!validAttempt(row)) {
      store.delete(scopeKey(scope));
      return null;
    }
    return attemptOf(row);
  });
}

/**
 * Stores a new attempt (with its file's bytes) before its first request leaves. Another tab's attempt
 * for the same dialogue is never overwritten: it comes back as `existing`, and the caller adopts it
 * instead of sending.
 */
export async function createAttempt(attempt: StoredAttempt): Promise<{ existing: StoredAttempt | null }> {
  const file = attempt.file ? { ...info(attempt.file), bytes: await fileBytes(attempt.file) } : null;
  return transact([ATTEMPTS], "readwrite", async (transaction) => {
    const store = transaction.objectStore(ATTEMPTS);
    const current = await done(store.get(scopeKey(attempt)));
    if (validAttempt(current) && current.key !== attempt.key) return { existing: attemptOf(current) };
    store.put({ ...attempt, file } satisfies AttemptRow);
    return { existing: null };
  }, true);
}

/** Updates the attempt's state (its text and file stay as stored), unless the record holds another attempt. */
export async function updateAttempt(attempt: StoredAttempt): Promise<void> {
  await transact([ATTEMPTS], "readwrite", async (transaction) => {
    const store = transaction.objectStore(ATTEMPTS);
    const current = await done(store.get(scopeKey(attempt)));
    if (!validAttempt(current) || current.key !== attempt.key) return;
    store.put({ ...current, state: attempt.state, reason: attempt.reason, tries: attempt.tries } satisfies AttemptRow);
  }, true);
}

/** Removes the attempt with this key; another attempt of the same dialogue stays. */
export async function removeAttempt(scope: WorkScope, key: string): Promise<void> {
  await transact([ATTEMPTS], "readwrite", async (transaction) => {
    const store = transaction.objectStore(ATTEMPTS);
    const current = await done(store.get(scopeKey(scope)));
    if (current !== undefined && (!validAttempt(current) || current.key === key)) store.delete(scopeKey(scope));
  }, true);
}

/** How much unsent work of the account the browser keeps. */
export async function countWork(account: string): Promise<{ drafts: number; attempts: number }> {
  return transact([DRAFTS, ATTEMPTS], "readonly", async (transaction) => {
    const [drafts, attempts] = await Promise.all([
      done(transaction.objectStore(DRAFTS).count(accountRange(account))),
      done(transaction.objectStore(ATTEMPTS).count(accountRange(account))),
    ]);
    return { drafts, attempts };
  });
}

/** Removes everything the account left in this browser (an explicit sign-out). */
export async function clearWork(account: string): Promise<void> {
  await transact([DRAFTS, FILES, ATTEMPTS], "readwrite", (transaction) => {
    for (const name of [DRAFTS, FILES, ATTEMPTS]) transaction.objectStore(name).delete(accountRange(account));
  }, true);
}
