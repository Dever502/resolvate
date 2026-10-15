// The operator's unsent work kept in the browser (IndexedDB), per account, project and dialogue:
// drafts (text and up to five files) and send attempts whose outcome is not known yet. Nothing of the
// conversation itself is stored, and nothing is read before the session check named the account.
// Files are kept as their bytes (an ArrayBuffer with name, type and date): WebKit keeps no Blobs in
// IndexedDB in private windows. Each file of a draft has a record of its own (the draft's key plus the
// file's id), written once when the file is attached, not with every edit of the text or of another
// file. Every failure becomes a StorageError the caller can explain; nothing here deletes work on its
// own, except records too damaged to be used.

export const WORK_DB = "resolvate-work";
/** 2: a draft holds several files (version 1 kept one, in a store of its own: moved over on upgrade). */
const DB_VERSION = 2;
/** The shape of the stored attempts; a record of another version is skipped. */
export const RECORD_VERSION = 1;
/** The shape of the stored drafts (1 held one file); a record of another version is skipped. */
export const DRAFT_VERSION = 2;

/** Which dialogue a record belongs to. */
export interface WorkScope {
  account: string;
  project: string;
  ticket: string;
}

/** A file of a draft and the id its bytes are stored under. */
export interface DraftFile {
  id: string;
  file: File;
}

export interface StoredDraft extends WorkScope {
  v: typeof DRAFT_VERSION;
  text: string;
  /** In the order they were attached. */
  files: DraftFile[];
  /** The names of files that could not be stored or read back: they have to be attached again. */
  lostFiles: string[];
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

/**
 * What a draft write does with the files' bytes: stores `put` (by file id) and removes `drop`; the
 * other files of the draft keep the bytes stored before.
 */
export interface FileChange {
  put: Map<string, ArrayBuffer>;
  drop: string[];
}

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
const DRAFT_FILES = "draftFiles";
/** Version 1's one file per draft, under the draft's key: moved to DRAFT_FILES by the upgrade, then removed. */
const LEGACY_FILES = "files";
const ATTEMPTS = "attempts";
const KEY_PATH = ["account", "project", "ticket"];
const FILE_KEY_PATH = [...KEY_PATH, "id"];

/** A file's description next to the draft; its bytes live in DRAFT_FILES under the draft's key and its id. */
interface FileInfo {
  name: string;
  type: string;
  size: number;
  lastModified: number;
}
interface PackedFile extends FileInfo {
  bytes: ArrayBuffer;
}
type StoredInfo = FileInfo & { id: string };
type DraftRow = Omit<StoredDraft, "files"> & { files: StoredInfo[] };
type FileRow = WorkScope & { id: string } & PackedFile;
type AttemptRow = Omit<StoredAttempt, "file"> & { file: PackedFile | null };
/** A draft as version 1 stored it. */
interface LegacyDraftRow extends WorkScope {
  v: 1;
  text: string;
  file: FileInfo | null;
  lostFile: string | null;
  rev: string;
  tab: string;
  updatedAt: number;
}

const scopeKey = ({ account, project, ticket }: WorkScope): IDBValidKey => [account, project, ticket];
const fileKey = ({ account, project, ticket }: WorkScope, id: string): IDBValidKey => [account, project, ticket, id];
const scopeOf = ({ account, project, ticket }: WorkScope): WorkScope => ({ account, project, ticket });
/** Every key of one account: arrays sort after strings, so [account, []] closes the range. */
const accountRange = (account: string): IDBKeyRange => IDBKeyRange.bound([account], [account, []]);
/** The files of one draft: [account, project, ticket, id]. */
const draftRange = ({ account, project, ticket }: WorkScope): IDBKeyRange =>
  IDBKeyRange.bound([account, project, ticket], [account, project, ticket, []]);

function problemOf(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "QuotaExceededError") return new StorageError("quota", "В браузере не хватает места.");
  if (name === "SecurityError" || name === "InvalidStateError") {
    return new StorageError("unavailable", "Браузер не даёт сохранять данные на этом устройстве.");
  }
  return new StorageError("failed", "Не удалось сохранить данные в браузере.");
}

const info = (file: FileInfo): FileInfo => ({ name: file.name, type: file.type, size: file.size, lastModified: file.lastModified });
/** One file described twice (a draft's row and its bytes, or a file and its copy read back). */
const sameInfo = (a: FileInfo | null, b: FileInfo | null): boolean =>
  a === b || (a !== null && b !== null && a.name === b.name && a.type === b.type && a.size === b.size && a.lastModified === b.lastModified);
/** The same files in the same order, by their descriptions. */
const sameInfos = (a: FileInfo[], b: FileInfo[]): boolean => a.length === b.length && a.every((item, index) => sameInfo(item, b[index]!));
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

function validLegacy(value: unknown): value is LegacyDraftRow {
  const row = value as LegacyDraftRow | null;
  return Boolean(row) && row!.v === 1 && text(row!.text) && (row!.file === null || validInfo(row!.file))
    && (row!.lostFile === null || text(row!.lostFile)) && text(row!.rev) && text(row!.tab) && number(row!.updatedAt);
}

/**
 * Version 1 drafts become version 2 inside the upgrade, all of them or none: the one file's bytes move
 * to DRAFT_FILES under a new id (bytes that are missing or not this file's leave its name, to be
 * attached again), then `finished` runs. Records of other shapes are left to readDraft().
 */
function upgradeDrafts(transaction: IDBTransaction, finished: () => void): void {
  const drafts = transaction.objectStore(DRAFTS);
  const legacy = transaction.objectStore(LEGACY_FILES);
  const files = transaction.objectStore(DRAFT_FILES);
  const walk = drafts.openCursor();
  walk.onsuccess = () => {
    const cursor = walk.result;
    if (!cursor) {
      finished();
      return;
    }
    const row: unknown = cursor.value;
    if (!validLegacy(row)) {
      cursor.continue();
      return;
    }
    const { file, lostFile, ...rest } = row;
    const lostFiles = lostFile ? [lostFile] : [];
    const store = (kept: StoredInfo[]): void => {
      cursor.update({ ...rest, v: DRAFT_VERSION, files: kept, lostFiles } satisfies DraftRow);
      cursor.continue();
    };
    if (!file) {
      store([]);
      return;
    }
    const read = legacy.get(scopeKey(row));
    read.onsuccess = () => {
      const bytes: unknown = read.result;
      if (validPacked(bytes) && sameInfo(bytes, file)) {
        const id = crypto.randomUUID();
        files.put({ ...scopeOf(row), id, ...info(bytes), bytes: bytes.bytes } satisfies FileRow);
        store([{ id, ...info(file) }]);
      } else {
        lostFiles.push(file.name);
        store([]);
      }
    };
  };
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
      for (const name of [DRAFTS, ATTEMPTS]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: KEY_PATH });
      }
      if (!db.objectStoreNames.contains(DRAFT_FILES)) db.createObjectStore(DRAFT_FILES, { keyPath: FILE_KEY_PATH });
      if (db.objectStoreNames.contains(LEGACY_FILES)) upgradeDrafts(request.transaction!, () => db.deleteObjectStore(LEGACY_FILES));
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
  return Boolean(row) && row!.v === DRAFT_VERSION && text(row!.text)
    && Array.isArray(row!.files) && row!.files.every((file) => validInfo(file) && text(file.id))
    && Array.isArray(row!.lostFiles) && row!.lostFiles.every(text) && text(row!.rev) && text(row!.tab) && number(row!.updatedAt);
}

function validAttempt(value: unknown): value is AttemptRow {
  const row = value as AttemptRow | null;
  return Boolean(row) && row!.v === RECORD_VERSION && text(row!.key) && text(row!.text) && (row!.file === null || validPacked(row!.file))
    && (row!.state === "sending" || row!.state === "unknown") && text(row!.reason) && number(row!.tries) && number(row!.createdAt);
}

/**
 * The dialogue's draft, or null; a damaged record is removed, a file that cannot be read back is named.
 * Bytes the draft no longer lists (left by a write cut off with the page) are removed.
 */
export async function readDraft(scope: WorkScope): Promise<StoredDraft | null> {
  return transact([DRAFTS, DRAFT_FILES], "readwrite", async (transaction) => {
    const drafts = transaction.objectStore(DRAFTS);
    const files = transaction.objectStore(DRAFT_FILES);
    const row = await done(drafts.get(scopeKey(scope)));
    if (row === undefined) return null;
    if (!validDraft(row)) {
      drafts.delete(scopeKey(scope));
      files.delete(draftRange(scope));
      return null;
    }
    const kept: DraftFile[] = [];
    const lostFiles = [...row.lostFiles];
    for (const described of row.files) {
      // Another tab may have stored its own files meanwhile: only the bytes of this very file count.
      const bytes = await done(files.get(fileKey(scope, described.id)));
      if (validPacked(bytes) && sameInfo(bytes, described)) kept.push({ id: described.id, file: unpack(bytes) });
      else lostFiles.push(described.name);
    }
    for (const key of await done(files.getAllKeys(draftRange(scope)))) {
      if (!row.files.some((described) => described.id === (key as IDBValidKey[])[3])) files.delete(key);
    }
    return { ...row, files: kept, lostFiles };
  });
}

/**
 * Writes the draft (an empty one is removed instead) and, per `change`, its files' bytes. `known` is
 * the revision this tab last read or wrote: when the stored one differs and came from another tab, the
 * write still happens (the latest edit wins) and `conflict` tells the caller so it can say so. A file
 * whose bytes are not in `put` keeps the bytes stored before, which are this draft's only over this
 * tab's own last write: otherwise `refile` asks for a write with all the bytes (until then a read
 * names such a file as lost).
 */
export async function writeDraft(
  draft: StoredDraft,
  known: string | null,
  change: FileChange,
): Promise<{ conflict: boolean; refile: boolean }> {
  return transact([DRAFTS, DRAFT_FILES], "readwrite", (transaction) => {
    const drafts = transaction.objectStore(DRAFTS);
    const files = transaction.objectStore(DRAFT_FILES);
    const key = scopeKey(draft);
    // The read and the writes are queued at once and the transaction is committed: nothing waits for a
    // callback, so a write started while the page unloads still reaches the browser whole. Requests
    // run in order: the read sees the draft as it was before.
    const before = done(drafts.get(key));
    before.catch(() => undefined); // An aborted write rejects through the transaction instead.
    if (!draft.text && !draft.files.length && !draft.lostFiles.length) {
      drafts.delete(key);
      files.delete(draftRange(draft));
    } else {
      drafts.put({ ...draft, files: draft.files.map(({ id, file }) => ({ id, ...info(file) })) } satisfies DraftRow);
      for (const id of change.drop) files.delete(fileKey(draft, id));
      for (const { id, file } of draft.files) {
        const bytes = change.put.get(id);
        if (bytes) files.put({ ...scopeOf(draft), id, ...info(file), bytes } satisfies FileRow);
      }
    }
    transaction.commit();
    return before.then((current) => {
      const valid = validDraft(current);
      const ours = valid && current.rev === known;
      const described = draft.files.map(({ file }) => info(file));
      return {
        conflict: valid && !ours && current.tab !== draft.tab && (current.text !== draft.text || !sameInfos(current.files, described)),
        refile: !ours && draft.files.some(({ id }) => !change.put.has(id)),
      };
    });
  });
}

/**
 * A draft's text the page was left with before its write landed (kept in the tab, lib/navigation.ts):
 * written unless the stored draft is newer. The stored files stay; no text and no file remove the draft.
 */
export async function restoreDraft(left: WorkScope & { text: string; at: number }, tab: string): Promise<void> {
  await transact([DRAFTS, DRAFT_FILES], "readwrite", async (transaction) => {
    const drafts = transaction.objectStore(DRAFTS);
    const files = transaction.objectStore(DRAFT_FILES);
    const current = await done(drafts.get(scopeKey(left)));
    const valid = validDraft(current);
    if (valid && current.updatedAt >= left.at) return;
    const kept = valid ? current.files : [];
    const lostFiles = valid ? current.lostFiles : [];
    if (!valid) files.delete(draftRange(left));
    if (!left.text && !kept.length && !lostFiles.length) {
      drafts.delete(scopeKey(left));
      return;
    }
    drafts.put({
      v: DRAFT_VERSION, ...scopeOf(left), text: left.text, files: kept, lostFiles, rev: crypto.randomUUID(), tab, updatedAt: left.at,
    } satisfies DraftRow);
  });
}

/**
 * Removes the draft whose content was sent. A draft another tab wrote since this tab last saw it
 * (`known`), with other content, stays: it is not what was sent. True when no draft is left.
 */
export async function removeDraft(scope: WorkScope, known: string | null, sent: { text: string; files: File[] }): Promise<boolean> {
  // Read outside the transaction: IndexedDB cannot stay alive waiting for File.arrayBuffer().
  const bytes = await Promise.all(sent.files.map(fileBytes));
  return transact([DRAFTS, DRAFT_FILES], "readwrite", async (transaction) => {
    const drafts = transaction.objectStore(DRAFTS);
    const files = transaction.objectStore(DRAFT_FILES);
    const current = await done(drafts.get(scopeKey(scope)));
    if (validDraft(current) && current.rev !== known) {
      if (current.text !== sent.text || !sameInfos(current.files, sent.files.map(info))) return false;
      for (const [index, described] of current.files.entries()) {
        const stored = await done(files.get(fileKey(scope, described.id)));
        if (!validPacked(stored) || !sameBytes(stored.bytes, bytes[index]!)) return false;
      }
    }
    drafts.delete(scopeKey(scope));
    files.delete(draftRange(scope));
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
 * instead of sending. `replaces` is the key of this tab's attempt the server has just taken (the file
 * before this one in a queue): its record, if still there, gives way.
 */
export async function createAttempt(attempt: StoredAttempt, replaces: string | null = null): Promise<{ existing: StoredAttempt | null }> {
  const file = attempt.file ? { ...info(attempt.file), bytes: await fileBytes(attempt.file) } : null;
  return transact([ATTEMPTS], "readwrite", async (transaction) => {
    const store = transaction.objectStore(ATTEMPTS);
    const current = await done(store.get(scopeKey(attempt)));
    if (validAttempt(current) && current.key !== attempt.key && current.key !== replaces) return { existing: attemptOf(current) };
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
  await transact([DRAFTS, DRAFT_FILES, ATTEMPTS], "readwrite", (transaction) => {
    for (const name of [DRAFTS, DRAFT_FILES, ATTEMPTS]) transaction.objectStore(name).delete(accountRange(account));
  }, true);
}
