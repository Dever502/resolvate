import { IDBFactory, IDBKeyRange as FakeKeyRange, IDBObjectStore as FakeObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAFT_VERSION, RECORD_VERSION, StorageError, WORK_DB, clearWork, closeWork, countWork, createAttempt, fileBytes, readAttempt,
  readDraft, removeAttempt, removeDraft, restoreDraft, sameFile, updateAttempt, writeDraft, type DraftFile, type FileChange,
  type StoredAttempt, type StoredDraft, type WorkScope,
} from "./workStore";

// The storage layer against a spec-following IndexedDB (fake-indexeddb): happy-dom has none. The real
// engines are covered by e2e/persistence.spec.ts, which reloads the console.
const anna: WorkScope = { account: "a1", project: "p1", ticket: "t1" };
const draft = (text: string, extra: Partial<StoredDraft> = {}): StoredDraft => ({
  v: DRAFT_VERSION, ...anna, text, files: [], lostFiles: [], rev: crypto.randomUUID(), tab: "tab-1", updatedAt: Date.now(), ...extra,
});
const attempt = (key: string, extra: Partial<StoredAttempt> = {}): StoredAttempt => ({
  v: RECORD_VERSION, ...anna, key, text: "Ответ", file: null, state: "sending", reason: "", tries: 0, createdAt: Date.now(), ...extra,
});
/** Keeps the bytes stored before. */
const same = (): FileChange => ({ put: new Map(), drop: [] });
/** Stores these files' bytes (and drops the ids given). */
async function bytesOf(files: DraftFile[], drop: string[] = []): Promise<FileChange> {
  return { put: new Map(await Promise.all(files.map(async ({ id, file }) => [id, await fileBytes(file)] as const))), drop };
}
const names = (stored: StoredDraft | null) => stored?.files.map(({ file }) => file.name);

/** Opens the database as the version 1 console left it: one file per draft in "files". */
function legacy(rows: { drafts: object[]; files: object[] }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(WORK_DB, 1);
    request.onupgradeneeded = () => {
      for (const name of ["drafts", "files", "attempts"]) request.result.createObjectStore(name, { keyPath: ["account", "project", "ticket"] });
    };
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(["drafts", "files"], "readwrite");
      for (const row of rows.drafts) transaction.objectStore("drafts").put(row);
      for (const row of rows.files) transaction.objectStore("files").put(row);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
    request.onerror = () => reject(request.error);
  });
}

describe("work store", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", FakeKeyRange);
  });
  afterEach(async () => {
    await closeWork();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("compares actual file content and keeps another tab's same-metadata replacement", async () => {
    const file = (bytes: string) => new File([bytes], "same.png", { type: "image/png", lastModified: 1000 });
    const original = file("AAAA");
    const replacement = file("BBBB");
    expect(await sameFile(original, file("AAAA"))).toBe(true);
    expect(await sameFile(original, replacement)).toBe(false);
    const first = draft("caption", { files: [{ id: "f1", file: original }] });
    await writeDraft(first, null, await bytesOf(first.files));
    const theirs = draft("caption", { files: [{ id: "f2", file: replacement }], tab: "another-tab" });
    await writeDraft(theirs, first.rev, await bytesOf(theirs.files));
    expect(await removeDraft(anna, first.rev, { text: "caption", files: [original] })).toBe(false);
    expect(await (await readDraft(anna))?.files[0]?.file.text()).toBe("BBBB");
    expect(await removeDraft(anna, first.rev, { text: "caption", files: [file("BBBB")] })).toBe(true);
  });

  it("an unreadable file is never assumed equal", async () => {
    const original = new File(["AAAA"], "same.png", { lastModified: 1000 });
    const broken = new File(["AAAA"], "same.png", { lastModified: 1000 });
    vi.spyOn(broken, "arrayBuffer").mockRejectedValue(new Error("unreadable"));
    expect(await sameFile(original, broken)).toBe(false);
  });

  it("keeps a draft; an empty draft is removed", async () => {
    await writeDraft(draft("Привет"), null, same());
    const stored = await readDraft(anna);
    expect(stored).toMatchObject({ text: "Привет", files: [], lostFiles: [], tab: "tab-1" });
    await writeDraft(draft(""), stored!.rev, same());
    expect(await readDraft(anna)).toBeNull();
  });

  it("keeps files as their bytes, in order; a text edit leaves them, another tab's files never pass for these", async () => {
    const photo = new File(["png bytes"], "photo.png", { type: "image/png", lastModified: 1000 });
    const scan = new File(["pdf bytes"], "scan.pdf", { type: "application/pdf", lastModified: 2000 });
    const files = [{ id: "f1", file: photo }, { id: "f2", file: scan }];
    const first = draft("С файлами", { files });
    await writeDraft(first, null, await bytesOf(files));
    const back = await readDraft(anna);
    expect(back).toMatchObject({ text: "С файлами", lostFiles: [] });
    expect(back!.files.map(({ id }) => id)).toEqual(["f1", "f2"]);
    expect(back!.files[0]!.file).toMatchObject({ name: "photo.png", type: "image/png", size: photo.size, lastModified: 1000 });
    expect(await Promise.all(back!.files.map(({ file }) => file.text()))).toEqual(["png bytes", "pdf bytes"]);
    // A text edit over this tab's own last write keeps the stored bytes.
    const edited = draft("С файлами, исправлено", { files });
    expect(await writeDraft(edited, first.rev, same())).toEqual({ conflict: false, refile: false });
    expect(await Promise.all((await readDraft(anna))!.files.map(({ file }) => file.text()))).toEqual(["png bytes", "pdf bytes"]);
    // Another tab stores its own file; this tab's next write without bytes cannot vouch for them.
    const voice = new File(["ogg bytes"], "voice.ogg", { type: "audio/ogg", lastModified: 3000 });
    const theirs = draft("Из другой вкладки", { tab: "tab-2", files: [{ id: "f3", file: voice }] });
    await writeDraft(theirs, null, await bytesOf(theirs.files));
    const mine = draft("Моё", { files });
    expect(await writeDraft(mine, edited.rev, same())).toEqual({ conflict: true, refile: true });
    expect(await writeDraft(draft("Моё", { files }), mine.rev, await bytesOf(files))).toEqual({ conflict: false, refile: false });
    expect(names(await readDraft(anna))).toEqual(["photo.png", "scan.pdf"]);
  });

  it("removing one file of several drops its bytes only; bytes no draft lists are cleaned on read", async () => {
    const file = (name: string) => ({ id: name, file: new File([name], `${name}.pdf`, { type: "application/pdf", lastModified: 1 }) });
    const [a, b, c] = [file("a"), file("b"), file("c")];
    const first = draft("", { files: [a, b, c] });
    await writeDraft(first, null, await bytesOf([a, b, c]));
    const second = draft("", { files: [a, c] });
    expect(await writeDraft(second, first.rev, { put: new Map(), drop: ["b"] })).toEqual({ conflict: false, refile: false });
    expect(names(await readDraft(anna))).toEqual(["a.pdf", "c.pdf"]);
    // A write cut off before its drop: the read removes the bytes the draft no longer lists.
    const third = draft("", { files: [c] });
    await writeDraft(third, second.rev, same());
    expect(names(await readDraft(anna))).toEqual(["c.pdf"]);
    // A draft whose bytes are gone names the file to be attached again.
    expect(await writeDraft(draft("", { files: [c, file("d")] }), third.rev, same())).toEqual({ conflict: false, refile: false });
    expect(await readDraft(anna)).toMatchObject({ lostFiles: ["d.pdf"] });
  });

  it("applies writes in the order they were made: an older text never lands over a newer one", async () => {
    const writes = ["П", "Пр", "При", "Прив", "Привет"].map((text) => writeDraft(draft(text), null, same()));
    await Promise.all(writes);
    expect((await readDraft(anna))?.text).toBe("Привет");
    // A removal made after a write wins; a write made after the removal comes back.
    const late = writeDraft(draft("Отправлено"), null, same());
    const gone = removeDraft(anna, null, { text: "Отправлено", files: [] });
    await Promise.all([late, gone]);
    expect(await readDraft(anna)).toBeNull();
  });

  it("merges a text the page was left with unless the stored draft is newer; the stored files stay", async () => {
    const photo = { id: "f1", file: new File(["png bytes"], "photo.png", { type: "image/png", lastModified: 1000 }) };
    await writeDraft(draft("Старый", { files: [photo], updatedAt: 1_000 }), null, await bytesOf([photo]));
    await restoreDraft({ ...anna, text: "Новее", at: 2_000 }, "tab-2");
    const merged = await readDraft(anna);
    expect(merged).toMatchObject({ text: "Новее", updatedAt: 2_000, tab: "tab-2", lostFiles: [] });
    expect(names(merged)).toEqual(["photo.png"]);
    // A text older than the stored draft (another tab wrote later) is dropped.
    await restoreDraft({ ...anna, text: "Старее", at: 1_500 }, "tab-3");
    expect((await readDraft(anna))?.text).toBe("Новее");
    // No text and no file: no draft.
    expect(await removeDraft(anna, merged!.rev, { text: "Новее", files: [photo.file] })).toBe(true);
    await writeDraft(draft("Набирается"), null, same());
    await restoreDraft({ ...anna, text: "", at: Date.now() + 1_000 }, "tab-2");
    expect(await readDraft(anna)).toBeNull();
    await restoreDraft({ ...anna, text: "Без черновика", at: 3_000 }, "tab-2");
    expect((await readDraft(anna))?.text).toBe("Без черновика");
  });

  it("removes a sent draft, but not another tab's newer one with other content", async () => {
    const mine = draft("Мой ответ");
    await writeDraft(mine, null, same());
    expect(await removeDraft(anna, mine.rev, { text: "Мой ответ", files: [] })).toBe(true);
    expect(await readDraft(anna)).toBeNull();
    // Written by another tab after this one last saw the draft.
    await writeDraft(draft("Черновик другой вкладки", { tab: "tab-2" }), null, same());
    expect(await removeDraft(anna, mine.rev, { text: "Мой ответ", files: [] })).toBe(false);
    expect((await readDraft(anna))?.text).toBe("Черновик другой вкладки");
    // The same content is what was sent, whoever wrote it.
    expect(await removeDraft(anna, mine.rev, { text: "Черновик другой вкладки", files: [] })).toBe(true);
    expect(await readDraft(anna)).toBeNull();
  });

  it("tells a write that another tab changed the draft since this tab last saw it", async () => {
    const first = draft("Из первой вкладки", { tab: "tab-1" });
    expect(await writeDraft(first, null, same())).toEqual({ conflict: false, refile: false });
    const second = draft("Из второй вкладки", { tab: "tab-2" });
    // The second tab never read the first tab's revision.
    expect(await writeDraft(second, null, same())).toEqual({ conflict: true, refile: false });
    expect((await readDraft(anna))?.text).toBe("Из второй вкладки");
    // Its own next write, knowing its revision, is no conflict.
    const own = draft("Из второй вкладки!", { tab: "tab-2" });
    expect(await writeDraft(own, second.rev, same())).toEqual({ conflict: false, refile: false });
    // The same text with another file is a change too.
    const files = [{ id: "f1", file: new File(["x"], "a.pdf", { type: "application/pdf" }) }];
    expect(await writeDraft(draft("Из второй вкладки!", { tab: "tab-1", files }), first.rev, await bytesOf(files)))
      .toEqual({ conflict: true, refile: false });
  });

  it("moves a version 1 draft and its one file over on upgrade; a missing file is named", async () => {
    const png = new File(["png bytes"], "photo.png", { type: "image/png", lastModified: 1000 });
    const described = { name: "photo.png", type: "image/png", size: png.size, lastModified: 1000 };
    const old = { v: 1, rev: "r1", tab: "old-tab", updatedAt: 1_000 };
    await legacy({
      drafts: [
        { ...anna, ...old, text: "Со старым фото", file: described, lostFile: null },
        { ...anna, ticket: "t2", ...old, text: "Без байтов", file: { ...described, name: "gone.png" }, lostFile: null },
        { ...anna, ticket: "t3", ...old, text: "Не сохранилось", file: null, lostFile: "big.pdf" },
      ],
      files: [{ ...anna, ...described, bytes: await png.arrayBuffer() }],
    });
    const migrated = await readDraft(anna);
    expect(migrated).toMatchObject({ v: DRAFT_VERSION, text: "Со старым фото", lostFiles: [], rev: "r1", tab: "old-tab" });
    expect(names(migrated)).toEqual(["photo.png"]);
    expect(await migrated!.files[0]!.file.text()).toBe("png bytes");
    expect(await readDraft({ ...anna, ticket: "t2" })).toMatchObject({ text: "Без байтов", files: [], lostFiles: ["gone.png"] });
    expect(await readDraft({ ...anna, ticket: "t3" })).toMatchObject({ text: "Не сохранилось", files: [], lostFiles: ["big.pdf"] });
    // The old store is gone; the new one is written as usual.
    await writeDraft(draft("Дальше", { rev: "r2", files: migrated!.files }), "r1", same());
    expect(await (await readDraft(anna))!.files[0]!.file.text()).toBe("png bytes");
  });

  it("never overwrites another attempt of the same dialogue, and removes only its own", async () => {
    expect(await createAttempt(attempt("k1"))).toEqual({ existing: null });
    const other = await createAttempt(attempt("k2", { text: "Другой текст" }));
    expect(other.existing?.key).toBe("k1");
    expect((await readAttempt(anna))?.key).toBe("k1");
    await updateAttempt(attempt("k2", { state: "unknown" }));
    expect((await readAttempt(anna))).toMatchObject({ key: "k1", state: "sending" });
    await updateAttempt(attempt("k1", { state: "unknown", reason: "Нет связи с сервером.", tries: 1 }));
    expect((await readAttempt(anna))).toMatchObject({ key: "k1", state: "unknown", reason: "Нет связи с сервером.", tries: 1 });
    await removeAttempt(anna, "k2");
    expect((await readAttempt(anna))?.key).toBe("k1");
    await removeAttempt(anna, "k1");
    expect(await readAttempt(anna)).toBeNull();
  });

  it("the attempt of the next file replaces only the one it names: the file before it, taken by the server", async () => {
    await createAttempt(attempt("k1"));
    expect(await createAttempt(attempt("k3"), "k2")).toMatchObject({ existing: { key: "k1" } });
    expect(await createAttempt(attempt("k2"), "k1")).toEqual({ existing: null });
    expect((await readAttempt(anna))?.key).toBe("k2");
    // The late removal of the file before it leaves it alone.
    await removeAttempt(anna, "k1");
    expect((await readAttempt(anna))?.key).toBe("k2");
  });

  it("keeps accounts apart: counting and clearing one leaves the other", async () => {
    const files = [{ id: "f1", file: new File(["x"], "a.pdf", { type: "application/pdf" }) }];
    await writeDraft(draft("Мой", { files }), null, await bytesOf(files));
    await createAttempt(attempt("k1"));
    await writeDraft(draft("Чужой", { account: "a2", files }), null, await bytesOf(files));
    await writeDraft(draft("Мой в другом проекте", { project: "p2" }), null, same());
    expect(await countWork("a1")).toEqual({ drafts: 2, attempts: 1 });
    expect(await readDraft({ ...anna, account: "a2" })).toMatchObject({ text: "Чужой" });
    await clearWork("a1");
    expect(await countWork("a1")).toEqual({ drafts: 0, attempts: 0 });
    // The account's files went with its drafts: a draft written again under the same ids has none.
    await writeDraft(draft("Снова", { files }), null, same());
    expect(await readDraft(anna)).toMatchObject({ files: [], lostFiles: ["a.pdf"] });
    expect(names(await readDraft({ ...anna, account: "a2" }))).toEqual(["a.pdf"]);
  });

  it("skips and removes a damaged or older record instead of failing", async () => {
    await writeDraft(draft("Старый формат"), null, same());
    await closeWork();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(WORK_DB);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(["drafts", "attempts"], "readwrite");
        transaction.objectStore("drafts").put({ ...anna, v: 99, text: 42 });
        transaction.objectStore("attempts").put({ ...anna, v: RECORD_VERSION, key: "k", text: "x", file: "not a file", state: "lost", tries: "1" });
        transaction.oncomplete = () => {
          db.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
      request.onerror = () => reject(request.error);
    });
    expect(await readDraft(anna)).toBeNull();
    expect(await readAttempt(anna)).toBeNull();
    expect(await countWork("a1")).toEqual({ drafts: 0, attempts: 0 });
  });

  it("explains a browser without storage and a full one", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await closeWork();
    await expect(readDraft(anna)).rejects.toMatchObject({ problem: "unavailable" });
    vi.stubGlobal("indexedDB", new IDBFactory());
    await closeWork();
    const put = FakeObjectStore.prototype.put;
    vi.spyOn(FakeObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if ((value as { bytes?: unknown }).bytes) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      return put.call(this, value, key);
    });
    const files = [{ id: "f1", file: new File(["x"], "big.pdf") }];
    const error = await writeDraft(draft("С файлом", { files }), null, await bytesOf(files)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).problem).toBe("quota");
    await writeDraft(draft("Без файла", { lostFiles: ["big.pdf"] }), null, same());
    expect(await readDraft(anna)).toMatchObject({ text: "Без файла", files: [], lostFiles: ["big.pdf"] });
  });

  it("gives up a database that never opens: the caller treats it as a browser without storage", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await closeWork();
      // A browser fault: the open request never answers.
      vi.stubGlobal("indexedDB", { open: () => ({}) });
      const reading = readDraft(anna).catch((caught: unknown) => caught);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await reading).toMatchObject({ problem: "unavailable", message: "Хранилище браузера не отвечает." });
      // The next call tries again.
      vi.stubGlobal("indexedDB", new IDBFactory());
      expect(await readDraft(anna)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
