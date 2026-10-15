import { mount, flushPromises, enableAutoUnmount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { TooltipProvider } from "reka-ui";
import { h } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FILE_BYTES } from "../../lib/attachment";
import { useChatStore } from "../../stores/chat";
import { useProjectsStore } from "../../stores/projects";
import { useSessionStore } from "../../stores/session";
import { useTicketsStore } from "../../stores/tickets";
import { useWorkspaceStore } from "../../stores/workspace";
import Composer from "./Composer.vue";

const renderComposer = () => mount(TooltipProvider, { slots: { default: () => h(Composer) } });
enableAutoUnmount(afterEach);

describe("grouped quick replies", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useSessionStore().signIn({ account: { id: "a", name: "Operator", login: "operator", role: "operator",
      active: true, telegram_id: null }, csrf: "c" });
    useProjectsStore().currentId = "p1";
    const chat = useChatStore();
    chat.ticketId = "t1";
    chat.drafts.set("t1", { text: "", files: [] });
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("does not send a slash query while the options are loading", async () => {
    vi.spyOn(useSessionStore(), "api").mockImplementation(() => new Promise(() => {}));
    const send = vi.spyOn(useChatStore(), "send");
    const wrapper = renderComposer();
    await flushPromises();
    await wrapper.get("textarea").setValue("/опл");
    await wrapper.get("textarea").trigger("keydown", { key: "Enter" });
    expect(send).not.toHaveBeenCalled();
    expect(useChatStore().draft?.text).toBe("/опл");
    wrapper.unmount();
  });

  it("ignores a pending lookup after changing project or dialogue", async () => {
    let finish!: (rows: unknown) => void;
    vi.spyOn(useSessionStore(), "api").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const wrapper = renderComposer();
    await flushPromises();
    await wrapper.get("textarea").setValue("/");
    await vi.advanceTimersByTimeAsync(200);
    useProjectsStore().currentId = "p2";
    useChatStore().ticketId = "t2";
    await flushPromises();
    finish([{ id: "private", name: "private_group", revision: 0 }]);
    await flushPromises();
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("private_group");
    wrapper.unmount();
  });

  it("keeps a draft when the slash button is opened and cancelled", async () => {
    vi.spyOn(useSessionStore(), "api").mockResolvedValue([]);
    const chat = useChatStore();
    chat.edit("Существующий черновик");
    const wrapper = renderComposer();
    await flushPromises();
    await wrapper.get('[aria-label="Готовые ответы"]').trigger("click");
    await vi.advanceTimersByTimeAsync(200);
    await wrapper.get('[aria-label="Закрыть готовые ответы"]').trigger("click");
    expect(chat.draft?.text).toBe("Существующий черновик");
    wrapper.unmount();
  });

  const groupsOf = (...names: string[]) => names.map((name, index) => ({ id: `g${index}`, name, revision: 0 }));

  it("a failed lookup says so with a retry, apart from \"nothing found\"", async () => {
    const api = vi.spyOn(useSessionStore(), "api").mockRejectedValueOnce(new Error("Сервис недоступен."))
      .mockResolvedValue(groupsOf("общее"));
    const wrapper = renderComposer();
    await flushPromises();
    await wrapper.get('[aria-label="Готовые ответы"]').trigger("click");
    await vi.advanceTimersByTimeAsync(200);
    await flushPromises();
    const failure = wrapper.get('.reply-options [role="alert"]');
    expect(failure.text()).toContain("Не удалось загрузить готовые ответы.");
    expect(wrapper.text()).not.toContain("Ничего не найдено");
    await failure.get("button").trigger("click");
    await vi.advanceTimersByTimeAsync(200);
    await flushPromises();
    expect(api).toHaveBeenCalledTimes(2);
    expect(wrapper.find('.reply-options [role="alert"]').exists()).toBe(false);
    expect(wrapper.findAll('[role="option"]').map((option) => option.text())).toEqual(["/общее"]);
    wrapper.unmount();
  });

  it("opened by the button, its search field points at the options and the reply box does not", async () => {
    vi.spyOn(useSessionStore(), "api").mockResolvedValue(groupsOf("общее", "оплата"));
    const wrapper = renderComposer();
    await flushPromises();
    await wrapper.get('[aria-label="Готовые ответы"]').trigger("click");
    await vi.advanceTimersByTimeAsync(200);
    await flushPromises();
    const search = wrapper.get('[aria-label="Поиск готовых ответов"]');
    const list = wrapper.get('[role="listbox"]');
    expect(search.attributes()).toMatchObject({ role: "combobox", "aria-expanded": "true", "aria-autocomplete": "list" });
    expect(search.attributes("aria-controls")).toBe(list.attributes("id"));
    expect(search.attributes("aria-activedescendant")).toBe(wrapper.findAll('[role="option"]')[0]!.attributes("id"));
    await search.trigger("keydown", { key: "ArrowDown" });
    expect(search.attributes("aria-activedescendant")).toBe(wrapper.findAll('[role="option"]')[1]!.attributes("id"));
    const field = wrapper.get("textarea");
    expect(field.attributes("aria-activedescendant")).toBeUndefined();
    expect(field.attributes("aria-controls")).toBeUndefined();
    expect(wrapper.get('[aria-label="Готовые ответы"]').attributes("aria-controls")).toBe(list.attributes("id"));
    wrapper.unmount();
  });

  it("Enter that ends an IME composition chooses nothing", async () => {
    vi.spyOn(useSessionStore(), "api").mockResolvedValue(groupsOf("общее"));
    const chat = useChatStore();
    const wrapper = renderComposer();
    await flushPromises();
    await wrapper.get("textarea").setValue("/");
    await vi.advanceTimersByTimeAsync(200);
    await flushPromises();
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", isComposing: true });
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", keyCode: 229 });
    expect(chat.draft?.text).toBe("/");
    expect(wrapper.find('[role="listbox"]').attributes("aria-label")).toBe("Группы ответов");
    wrapper.unmount();
  });

  it("Esc closes the list from a button inside it", async () => {
    vi.spyOn(useSessionStore(), "api").mockResolvedValue(groupsOf("общее"));
    const wrapper = renderComposer();
    await flushPromises();
    await wrapper.get('[aria-label="Готовые ответы"]').trigger("click");
    await vi.advanceTimersByTimeAsync(200);
    await flushPromises();
    await wrapper.get('[aria-label="Закрыть готовые ответы"]').trigger("keydown", { key: "Escape" });
    expect(wrapper.find(".reply-options").exists()).toBe(false);
    wrapper.unmount();
  });
});

describe("composer attachments", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useProjectsStore().currentId = "p1";
    const chat = useChatStore();
    chat.ticketId = "t1";
    chat.drafts.set("t1", { text: "Черновик", files: [] });
    vi.spyOn(useTicketsStore(), "sync").mockResolvedValue();
    vi.spyOn(useSessionStore(), "api").mockImplementation(async (path) => {
      if (path.endsWith("/sync")) return { items: [], order: [], removed: [], before: null, has_older: false };
      return { id: "t1", status: "open" };
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  /** One pick in the system file picker (several files with Ctrl/Cmd/Shift). */
  async function attach(wrapper: VueWrapper, ...files: File[]): Promise<void> {
    const picker = wrapper.get('input[type="file"]');
    expect(picker.attributes("multiple")).toBeDefined();
    Object.defineProperty(picker.element, "files", { configurable: true, value: files });
    await picker.trigger("change");
    await flushPromises();
    expect((picker.element as HTMLInputElement).value).toBe("");
  }
  /** A paste into the reply box with what a clipboard holds; true when the page took it. */
  async function paste(wrapper: VueWrapper, data: { types: string[]; files?: File[]; items?: { kind: string; getAsFile: () => File | null }[] }): Promise<boolean> {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { types: data.types, files: data.files ?? [], items: data.items ?? [] } });
    wrapper.get("textarea").element.dispatchEvent(event);
    await flushPromises();
    return event.defaultPrevented;
  }
  const pdf = (name = "report.pdf") => new File(["%PDF-test"], name, { type: "application/pdf" });
  const cards = (wrapper: VueWrapper) => wrapper.findAll(".attachment-preview").map((card) => card.get(".attachment-preview-name").text());
  const removeButton = (wrapper: VueWrapper, name: string) => wrapper.get(`[aria-label="Убрать вложение «${name}»"]`);
  const sendCalls = () => vi.mocked(useSessionStore().api).mock.calls.filter(([path]) => String(path).endsWith("/send"));

  it("a file attached to a long text keeps it and says the limit; Enter sends nothing; without the file it goes", async () => {
    const wrapper = renderComposer();
    const chat = useChatStore();
    chat.edit("я".repeat(900));
    await flushPromises();
    const field = wrapper.get("textarea");
    expect(field.attributes("maxlength")).toBeUndefined();
    expect(field.attributes("aria-invalid")).toBeUndefined();
    await attach(wrapper, pdf());
    expect(chat.draft?.text).toBe("я".repeat(900));
    expect(field.attributes("aria-invalid")).toBe("true");
    const limit = wrapper.get(`#${field.attributes("aria-describedby")}`);
    expect(limit.attributes("aria-live")).toBe("polite");
    expect(limit.text()).toContain("С вложением можно отправить не больше 800 символов: сократите текст или уберите вложение.");
    expect(limit.get('[aria-hidden="true"]').text()).toBe("900 / 800");
    await field.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(sendCalls()).toEqual([]);
    expect(chat.attempt).toBeNull();
    await removeButton(wrapper, "report.pdf").trigger("click");
    expect(field.attributes("aria-invalid")).toBeUndefined();
    expect(limit.text()).toBe("");
    await field.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(sendCalls()).toHaveLength(1);
  });

  it("an unsupported format is refused before the preview, and the attached file stays", async () => {
    const wrapper = renderComposer();
    const chat = useChatStore();
    const valid = pdf();
    await attach(wrapper, valid);
    await attach(wrapper, new File(["<svg/>"], "drawing.svg", { type: "image/svg+xml" }));
    expect(chat.draft?.files).toEqual([valid]);
    expect(cards(wrapper)).toEqual(["report.pdf"]);
  });

  it("several picked at once and more picked later go after them, in order; any one is removed, focus moving to the next", async () => {
    const wrapper = mount(TooltipProvider, { slots: { default: () => h(Composer) }, attachTo: document.body });
    const chat = useChatStore();
    await attach(wrapper, pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf"));
    await attach(wrapper, pdf("d.pdf"));
    expect(cards(wrapper)).toEqual(["a.pdf", "b.pdf", "c.pdf", "d.pdf"]);
    expect(wrapper.get(".attachment-tray").attributes("aria-label")).toBe("Выбранные вложения: 4 из 5");
    expect(chat.attempt).toBeNull();
    await removeButton(wrapper, "b.pdf").trigger("click");
    await flushPromises();
    expect(cards(wrapper)).toEqual(["a.pdf", "c.pdf", "d.pdf"]);
    expect(document.activeElement).toBe(removeButton(wrapper, "c.pdf").element);
    await removeButton(wrapper, "d.pdf").trigger("click");
    await flushPromises();
    expect(document.activeElement).toBe(removeButton(wrapper, "c.pdf").element);
    for (const name of ["a.pdf", "c.pdf"]) await removeButton(wrapper, name).trigger("click");
    await flushPromises();
    expect(wrapper.find(".attachment-tray").exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.get("textarea").element);
    expect(chat.draft).toEqual({ text: "Черновик", files: [] });
    expect(sendCalls()).toEqual([]);
    wrapper.unmount();
  });

  it("keeps the files and an unresolved attempt when another exceeds 20 MiB", async () => {
    const wrapper = renderComposer();
    const valid = pdf();
    Object.defineProperty(valid, "size", { value: MAX_FILE_BYTES });
    await attach(wrapper, valid);
    const chat = useChatStore();
    const pending = { key: "retry-key", project: "p1", ticket: "t1", text: "Черновик", file: valid, state: "unknown" as const, reason: "Нет связи с сервером.", tries: 1, createdAt: Date.now(), persisted: true };
    chat.attempts.set("p1/t1", pending);
    const large = pdf("too-large.pdf");
    Object.defineProperty(large, "size", { value: MAX_FILE_BYTES + 1 });
    await attach(wrapper, large);
    expect(chat.draft?.files).toEqual([valid]);
    expect(chat.attempt).toEqual(pending);
    expect(cards(wrapper)).toEqual(["report.pdf"]);
    // The draft's file is the one whose outcome is unknown.
    expect(wrapper.get(".attachment-preview").text()).toContain("Результат неизвестен");
  });

  it("pastes an image as an attachment named for the clipboard, keeping its type and bytes; text pastes as text", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 15, 14, 3, 22));
    try {
      const wrapper = renderComposer();
      const chat = useChatStore();
      const screenshot = new File(["png bytes"], "image.png", { type: "image/png" });
      expect(await paste(wrapper, { types: ["Files"], files: [screenshot] })).toBe(true);
      const [pasted] = chat.draft!.files;
      expect([pasted!.name, pasted!.type, await pasted!.text()]).toEqual(["clipboard-2026-10-15-140322.png", "image/png", "png bytes"]);
      // A clipboard that lists the image only among its items, without a name, and two at once.
      const unnamed = new File(["webp"], "", { type: "image/webp" });
      const items = [unnamed, new File(["jpeg"], "", { type: "image/jpeg" })].map((file) => ({ kind: "file", getAsFile: () => file }));
      expect(await paste(wrapper, { types: ["Files"], items })).toBe(true);
      expect(cards(wrapper)).toEqual(["clipboard-2026-10-15-140322.png", "clipboard-2026-10-15-140322.webp", "clipboard-2026-10-15-140322-2.jpg"]);
      // Text, a link or a copied quick reply are the browser's own paste, also with an image alongside (a copy from an office document).
      expect(await paste(wrapper, { types: ["text/plain"] })).toBe(false);
      expect(await paste(wrapper, { types: ["text/html", "text/plain", "Files"], files: [screenshot] })).toBe(false);
      expect(chat.draft?.files).toHaveLength(3);
      expect(chat.draft?.text).toBe("Черновик");
      // An unsupported image is said, not pasted as anything.
      expect(await paste(wrapper, { types: ["Files"], files: [new File(["gif"], "image.gif", { type: "image/gif" })] })).toBe(true);
      expect(useWorkspaceStore().notice).toContain("Этот формат не поддерживается.");
      expect(chat.draft?.files).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows how far a reply's files got, each file's state, and stops after the one on its way", async () => {
    const wrapper = renderComposer();
    const chat = useChatStore();
    const answers: ((value: unknown) => void)[] = [];
    vi.mocked(useSessionStore().api).mockImplementation(async (path) => {
      if (path.endsWith("/send")) return new Promise((resolve) => answers.push(resolve));
      if (path.endsWith("/sync")) return { items: [], order: [], removed: [], before: null, has_older: false };
      return { id: "t1", status: "open" };
    });
    await attach(wrapper, pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf"));
    await wrapper.get("textarea").trigger("keydown", { key: "Enter" });
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    await flushPromises();
    const progress = wrapper.get(".send-progress");
    expect(progress.get("[aria-live]").text()).toBe("Отправка файла 1 из 3. Принято сервером: 0 из 3.");
    const states = () => wrapper.findAll(".attachment-preview").map((card) => card.find(".attachment-preview-status").text());
    expect(states()).toEqual(["Отправляется…", "В очереди", "В очереди"]);
    // The file on its way cannot be removed; the waiting ones can.
    expect(removeButton(wrapper, "a.pdf").attributes("disabled")).toBeDefined();
    expect(removeButton(wrapper, "b.pdf").attributes("disabled")).toBeUndefined();
    answers[0]!({ id: "m1" });
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    await flushPromises();
    expect(progress.get("[aria-live]").text()).toBe("Отправка файла 2 из 3. Принято сервером: 1 из 3.");
    expect(cards(wrapper)).toEqual(["b.pdf", "c.pdf"]);
    await progress.get("button").trigger("click");
    expect(progress.get("[aria-live]").text()).toBe("Отправка остановится после текущего файла. Принято сервером: 1 из 3.");
    answers[1]!({ id: "m2" });
    await vi.waitFor(() => expect(chat.sending).toBe(false));
    await flushPromises();
    expect(wrapper.get(".send-progress [aria-live]").text())
      .toBe("Отправка остановлена. Принято сервером: 2 из 3. Неотправленные файлы остались в черновике: «Отправить» продолжит.");
    expect(wrapper.find(".send-progress button").exists()).toBe(false);
    expect(cards(wrapper)).toEqual(["c.pdf"]);
    expect(answers).toHaveLength(2);
    // Send goes on with what is left; once all of the reply is taken the line goes.
    await wrapper.get("textarea").trigger("keydown", { key: "Enter" });
    await vi.waitFor(() => expect(answers).toHaveLength(3));
    answers[2]!({ id: "m3" });
    await vi.waitFor(() => expect(chat.sending).toBe(false));
    await flushPromises();
    expect(wrapper.get(".send-progress").attributes("data-state")).toBeUndefined();
    expect(wrapper.get(".send-progress").text()).toBe("");
    expect(wrapper.find(".attachment-tray").exists()).toBe(false);
  });

  it("gives focus back to the reply box when the history settles the attempt whose banner had it", async () => {
    const wrapper = mount(TooltipProvider, { slots: { default: () => h(Composer) }, attachTo: document.body });
    const chat = useChatStore();
    chat.attempts.set("p1/t1", { key: "k", project: "p1", ticket: "t1", text: "Черновик", file: null, state: "unknown", reason: "Нет связи с сервером.", tries: 1, createdAt: Date.now(), persisted: true });
    await flushPromises();
    const retryButton = wrapper.get(".send-attempt .secondary").element as HTMLButtonElement;
    retryButton.focus();
    expect(document.activeElement).toBe(retryButton);
    chat.attempts.delete("p1/t1");
    await flushPromises();
    expect(wrapper.find(".send-attempt").exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.get("textarea").element);
    wrapper.unmount();
  });

  it("restores each dialogue's attachments and drops previews on reset", async () => {
    const wrapper = renderComposer();
    const chat = useChatStore();
    await attach(wrapper, pdf("anna.pdf"));
    const boris = pdf("boris.pdf");
    chat.drafts.set("t2", { text: "Другой текст", files: [boris, pdf("boris-2.pdf")] });
    chat.attempts.set("p1/t2", { key: "retry", project: "p1", ticket: "t2", text: "Другой текст", file: boris, state: "unknown", reason: "Нет связи с сервером.", tries: 1, createdAt: Date.now(), persisted: true });
    chat.ticketId = "t2";
    await flushPromises();
    expect(cards(wrapper)).toEqual(["boris.pdf", "boris-2.pdf"]);
    // The attempt belongs to its own dialogue only.
    expect(chat.attempt?.key).toBe("retry");
    expect(wrapper.find(".send-attempt").exists()).toBe(true);
    chat.ticketId = "t1";
    await flushPromises();
    expect(chat.attempt).toBeNull();
    expect(wrapper.find(".send-attempt").exists()).toBe(false);
    expect(cards(wrapper)).toEqual(["anna.pdf"]);
    expect(wrapper.get("textarea").element.value).toBe("Черновик");
    chat.reset();
    await flushPromises();
    expect(wrapper.find(".attachment-preview").exists()).toBe(false);
  });

  it("keeps the attempt (text, file and key) when its answer is lost, disables controls while sending, clears on success", async () => {
    const wrapper = renderComposer();
    const chat = useChatStore();
    const file = pdf();
    await attach(wrapper, file);
    let reject!: (error: Error) => void;
    const api = vi.mocked(useSessionStore().api);
    api.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", isComposing: true });
    expect(api).not.toHaveBeenCalled();
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", shiftKey: true });
    expect(api).not.toHaveBeenCalled();
    await wrapper.get("textarea").trigger("keydown", { key: "Enter" });
    const key = chat.attempt!.key;
    expect(key).toBeTruthy();
    expect(chat.attempt?.state).toBe("sending");
    await flushPromises();
    expect(removeButton(wrapper, "report.pdf").attributes("disabled")).toBeDefined();
    expect(wrapper.get('[aria-label="Прикрепить файл"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get("textarea").attributes("disabled")).toBeDefined();
    // One file alone has no progress line: its card says it is on its way.
    expect(wrapper.get(".send-progress").text()).toBe("");
    expect(wrapper.get(".attachment-preview-status").text()).toBe("Отправляется…");
    reject(new Error("Send failed"));
    await flushPromises();
    expect(chat.draft).toEqual({ text: "Черновик", files: [file] });
    expect(chat.attempt).toMatchObject({ key, state: "unknown", text: "Черновик", reason: "Send failed" });
    expect(wrapper.get(".send-attempt").text()).toContain("Результат отправки неизвестен.");
    expect(cards(wrapper)).toEqual(["report.pdf"]);
    // The same text and file again: the same attempt under its key.
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    const calls = sendCalls();
    expect(calls.map(([, options]) => options?.key)).toEqual([key, key]);
    const sentFile = calls[1]![1]?.form?.get("file") as File;
    expect([sentFile.name, sentFile.type, await sentFile.text()]).toEqual([file.name, file.type, await file.text()]);
    expect(chat.draft).toEqual({ text: "", files: [] });
    expect(chat.attempt).toBeNull();
    expect(wrapper.find(".attachment-preview").exists()).toBe(false);
    expect(wrapper.find(".send-attempt").exists()).toBe(false);
  });
});
