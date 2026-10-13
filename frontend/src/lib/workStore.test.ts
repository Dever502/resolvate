import { IDBFactory, IDBKeyRange as FakeKeyRange, IDBObjectStore as FakeObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RECORD_VERSION, StorageError, WORK_DB, clearWork, closeWork, countWork, createAttempt, fileBytes, readAttempt, readDraft,
  removeAttempt, removeDraft, restoreDraft, sameFile, updateAttempt, writeDraft, type StoredAttempt, type StoredDraft, type WorkScope,
} from "./workStore";

// The storage layer against a spec-following IndexedDB (fake-indexeddb): happy-dom has none. The real
// engines are covered by e2e/persistence.spec.ts, which reloads the console.
const anna: WorkScope = { account: "a1", project: "p1", ticket: "t1" };
const draft = (text: string, extra: Partial<StoredDraft> = {}): StoredDraft => ({
  v: RECORD_VERSION, ...anna, text, file: null, lostFile: null, rev: crypto.randomUUID(), tab: "tab-1", updatedAt: Date.now(), ...extra,
});
const attempt = (key: string, extra: Partial<StoredAttempt> = {}): StoredAttempt => ({
  v: RECORD_VERSION, ...anna, key, text: "Ответ", file: null, state: "sending", reason: "", tries: 0, createdAt: Date.now(), ...extra,
});

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
    const first = draft("caption", { file: original });
    await writeDraft(first, null, { bytes: await fileBytes(original) });
    await writeDraft(draft("caption", { file: replacement, tab: "another-tab" }), first.rev, { bytes: await fileBytes(replacement) });
    expect(await removeDraft(anna, first.rev, { text: "caption", file: original })).toBe(false);
    expect(await (await readDraft(anna))?.file?.text()).toBe("BBBB");
    expect(await removeDraft(anna, first.rev, { text: "caption", file: file("BBBB") })).toBe(true);
  });

  it("an unreadable file is never assumed equal", async () => {
    const original = new File(["AAAA"], "same.png", { lastModified: 1000 });
    const broken = new File(["AAAA"], "same.png", { lastModified: 1000 });
    vi.spyOn(broken, "arrayBuffer").mockRejectedValue(new Error("unreadable"));
    expect(await sameFile(original, broken)).toBe(false);
  });

  it("keeps a draft; an empty draft is removed", async () => {
    await writeDraft(draft("Привет"), null, null);
    const stored = await readDraft(anna);
    expect(stored).toMatchObject({ text: "Привет", file: null, lostFile: null, tab: "tab-1" });
    await writeDraft(draft(""), stored!.rev, null);
    expect(await readDraft(anna)).toBeNull();
  });

  it("keeps a file as its bytes; a text edit leaves them, another tab's file never passes for this one", async () => {
    const photo = new File(["png bytes"], "photo.png", { type: "image/png", lastModified: 1000 });
    const first = draft("С фото", { file: photo });
    await writeDraft(first, null, { bytes: await fileBytes(photo) });
    const back = await readDraft(anna);
    expect(back).toMatchObject({ text: "С фото", lostFile: null });
    expect(back!.file).toMatchObject({ name: "photo.png", type: "image/png", size: photo.size, lastModified: 1000 });
    expect(await back!.file!.text()).toBe("png bytes");
    // A text edit over this tab's own last write keeps the stored bytes.
    const edited = draft("С фото, исправлено", { file: photo });
    expect(await writeDraft(edited, first.rev, "same")).toEqual({ conflict: false, refile: false });
    expect(await (await readDraft(anna))!.file!.text()).toBe("png bytes");
    // Another tab stores its own file; this tab's next "same" write cannot vouch for the bytes.
    const scan = new File(["pdf bytes"], "scan.pdf", { type: "application/pdf", lastModified: 2000 });
    await writeDraft(draft("Из другой вкладки", { tab: "tab-2", file: scan }), null, { bytes: await fileBytes(scan) });
    const mine = draft("Моё", { file: photo });
    expect(await writeDraft(mine, edited.rev, "same")).toEqual({ conflict: true, refile: true });
    expect(await readDraft(anna)).toMatchObject({ text: "Моё", file: null, lostFile: "photo.png" });
    await writeDraft(draft("Моё", { file: photo }), mine.rev, { bytes: await fileBytes(photo) });
    expect(await (await readDraft(anna))!.file!.text()).toBe("png bytes");
  });

  it("applies writes in the order they were made: an older text never lands over a newer one", async () => {
    const writes = ["П", "Пр", "При", "Прив", "Привет"].map((text) => writeDraft(draft(text), null, null));
    await Promise.all(writes);
    expect((await readDraft(anna))?.text).toBe("Привет");
    // A removal made after a write wins; a write made after the removal comes back.
    const late = writeDraft(draft("Отправлено"), null, null);
    const gone = removeDraft(anna, null, { text: "Отправлено", file: null });
    await Promise.all([late, gone]);
    expect(await readDraft(anna)).toBeNull();
  });

  it("merges a text the page was left with unless the stored draft is newer; the stored file stays", async () => {
    const photo = new File(["png bytes"], "photo.png", { type: "image/png", lastModified: 1000 });
    await writeDraft(draft("Старый", { file: photo, updatedAt: 1_000 }), null, { bytes: await fileBytes(photo) });
    await restoreDraft({ ...anna, text: "Новее", at: 2_000 }, "tab-2");
    const merged = await readDraft(anna);
    expect(merged).toMatchObject({ text: "Новее", updatedAt: 2_000, tab: "tab-2", lostFile: null });
    expect(merged!.file?.name).toBe("photo.png");
    // A text older than the stored draft (another tab wrote later) is dropped.
    await restoreDraft({ ...anna, text: "Старее", at: 1_500 }, "tab-3");
    expect((await readDraft(anna))?.text).toBe("Новее");
    // No text and no file: no draft.
    expect(await removeDraft(anna, merged!.rev, { text: "Новее", file: photo })).toBe(true);
    await writeDraft(draft("Набирается"), null, null);
    await restoreDraft({ ...anna, text: "", at: Date.now() + 1_000 }, "tab-2");
    expect(await readDraft(anna)).toBeNull();
    await restoreDraft({ ...anna, text: "Без черновика", at: 3_000 }, "tab-2");
    expect((await readDraft(anna))?.text).toBe("Без черновика");
  });

  it("removes a sent draft, but not another tab's newer one with other content", async () => {
    const mine = draft("Мой ответ");
    await writeDraft(mine, null, null);
    expect(await removeDraft(anna, mine.rev, { text: "Мой ответ", file: null })).toBe(true);
    expect(await readDraft(anna)).toBeNull();
    // Written by another tab after this one last saw the draft.
    await writeDraft(draft("Черновик другой вкладки", { tab: "tab-2" }), null, null);
    expect(await removeDraft(anna, mine.rev, { text: "Мой ответ", file: null })).toBe(false);
    expect((await readDraft(anna))?.text).toBe("Черновик другой вкладки");
    // The same content is what was sent, whoever wrote it.
    expect(await removeDraft(anna, mine.rev, { text: "Черновик другой вкладки", file: null })).toBe(true);
    expect(await readDraft(anna)).toBeNull();
  });

  it("tells a write that another tab changed the draft since this tab last saw it", async () => {
    const first = draft("Из первой вкладки", { tab: "tab-1" });
    expect(await writeDraft(first, null, null)).toEqual({ conflict: false, refile: false });
    const second = draft("Из второй вкладки", { tab: "tab-2" });
    // The second tab never read the first tab's revision.
    expect(await writeDraft(second, null, null)).toEqual({ conflict: true, refile: false });
    expect((await readDraft(anna))?.text).toBe("Из второй вкладки");
    // Its own next write, knowing its revision, is no conflict.
    const own = draft("Из второй вкладки!", { tab: "tab-2" });
    expect(await writeDraft(own, second.rev, null)).toEqual({ conflict: false, refile: false });
    // The same text with another file is a change too.
    const file = new File(["x"], "a.pdf", { type: "application/pdf" });
    expect(await writeDraft(draft("Из второй вкладки!", { tab: "tab-1", file }), first.rev, { bytes: await fileBytes(file) }))
      .toEqual({ conflict: true, refile: false });
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

  it("keeps accounts apart: counting and clearing one leaves the other", async () => {
    await writeDraft(draft("Мой"), null, null);
    await createAttempt(attempt("k1"));
    await writeDraft(draft("Чужой", { account: "a2" }), null, null);
    await writeDraft(draft("Мой в другом проекте", { project: "p2" }), null, null);
    expect(await countWork("a1")).toEqual({ drafts: 2, attempts: 1 });
    expect(await readDraft({ ...anna, account: "a2" })).toMatchObject({ text: "Чужой" });
    await clearWork("a1");
    expect(await countWork("a1")).toEqual({ drafts: 0, attempts: 0 });
    expect(await readDraft({ ...anna, account: "a2" })).toMatchObject({ text: "Чужой" });
  });

  it("skips and removes a damaged or older record instead of failing", async () => {
    await writeDraft(draft("Старый формат"), null, null);
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
      if ((value as StoredDraft).file) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      return put.call(this, value, key);
    });
    const big = new File(["x"], "big.pdf");
    const error = await writeDraft(draft("С файлом", { file: big }), null, { bytes: await fileBytes(big) }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).problem).toBe("quota");
    await writeDraft(draft("Без файла", { lostFile: "big.pdf" }), null, null);
    expect(await readDraft(anna)).toMatchObject({ text: "Без файла", file: null, lostFile: "big.pdf" });
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
