import { mount, flushPromises, enableAutoUnmount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { TooltipProvider } from "reka-ui";
import { h, toRaw } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FILE_BYTES } from "../../lib/attachment";
import { useChatStore } from "../../stores/chat";
import { useProjectsStore } from "../../stores/projects";
import { useSessionStore } from "../../stores/session";
import { useTicketsStore } from "../../stores/tickets";
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
    chat.drafts.set("t1", { text: "", file: null });
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
    chat.drafts.set("t1", { text: "Черновик", file: null });
    vi.spyOn(useTicketsStore(), "sync").mockResolvedValue();
    vi.spyOn(useSessionStore(), "api").mockImplementation(async (path) => {
      if (path.endsWith("/sync")) return { items: [], order: [], removed: [], before: null, has_older: false };
      return { id: "t1", status: "open" };
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  async function attach(wrapper: VueWrapper, file: File): Promise<void> {
    const picker = wrapper.get('input[type="file"]');
    Object.defineProperty(picker.element, "files", { configurable: true, value: [file] });
    await picker.trigger("change");
    await flushPromises();
    expect((picker.element as HTMLInputElement).value).toBe("");
  }
  const pdf = (name = "report.pdf") => new File(["%PDF-test"], name, { type: "application/pdf" });

  it("a file attached to a long text keeps it and says the limit; Enter sends nothing; without the file it goes", async () => {
    const wrapper = renderComposer();
    const chat = useChatStore();
    const api = vi.mocked(useSessionStore().api);
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
    expect(api.mock.calls.filter(([path]) => String(path).endsWith("/send"))).toEqual([]);
    expect(chat.attempt).toBeNull();
    await wrapper.get('[aria-label="Убрать вложение"]').trigger("click");
    expect(field.attributes("aria-invalid")).toBeUndefined();
    expect(limit.text()).toBe("");
    await field.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(api.mock.calls.filter(([path]) => String(path).endsWith("/send"))).toHaveLength(1);
  });

  it("an unsupported format is refused before the preview, and the attached file stays", async () => {
    const wrapper = renderComposer();
    const chat = useChatStore();
    const valid = pdf();
    await attach(wrapper, valid);
    await attach(wrapper, new File(["<svg/>"], "drawing.svg", { type: "image/svg+xml" }));
    expect(toRaw(chat.draft?.file)).toBe(valid);
    expect(wrapper.text()).toContain("report.pdf");
    expect(wrapper.text()).not.toContain("drawing.svg");
  });

  it("selects, replaces and removes without changing text or starting a send", async () => {
    const wrapper = renderComposer();
    const chat = useChatStore();
    await attach(wrapper, pdf());
    expect(wrapper.text()).toContain("report.pdf");
    expect(chat.attempt).toBeNull();
    const replacement = pdf("new.pdf");
    await attach(wrapper, replacement);
    expect(wrapper.text()).not.toContain("report.pdf");
    expect(toRaw(chat.draft?.file)).toBe(replacement);
    await wrapper.get('[aria-label="Убрать вложение"]').trigger("click");
    expect(wrapper.find(".attachment-preview").exists()).toBe(false);
    expect(chat.draft).toEqual({ text: "Черновик", file: null });
  });

  it("keeps the previous file and an unresolved attempt when a replacement exceeds 20 MiB", async () => {
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
    expect(toRaw(chat.draft?.file)).toBe(valid);
    expect(chat.attempt).toEqual(pending);
    expect(wrapper.text()).toContain("report.pdf");
    expect(wrapper.text()).not.toContain("too-large.pdf");
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

  it("restores the dialogue's attachment and drops previews on reset", async () => {
    const wrapper = renderComposer();
    const chat = useChatStore();
    await attach(wrapper, pdf("anna.pdf"));
    const boris = pdf("boris.pdf");
    chat.drafts.set("t2", { text: "Другой текст", file: boris });
    chat.attempts.set("p1/t2", { key: "retry", project: "p1", ticket: "t2", text: "Другой текст", file: boris, state: "unknown", reason: "Нет связи с сервером.", tries: 1, createdAt: Date.now(), persisted: true });
    chat.ticketId = "t2";
    await flushPromises();
    expect(wrapper.text()).toContain("boris.pdf");
    expect(wrapper.text()).not.toContain("anna.pdf");
    // The attempt belongs to its own dialogue only.
    expect(chat.attempt?.key).toBe("retry");
    expect(wrapper.find(".send-attempt").exists()).toBe(true);
    chat.ticketId = "t1";
    await flushPromises();
    expect(chat.attempt).toBeNull();
    expect(wrapper.find(".send-attempt").exists()).toBe(false);
    expect(wrapper.text()).toContain("anna.pdf");
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
    expect(wrapper.get('[aria-label="Убрать вложение"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[aria-label="Прикрепить файл"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get("textarea").attributes("disabled")).toBeDefined();
    reject(new Error("Send failed"));
    await flushPromises();
    expect(toRaw(chat.draft)).toEqual({ text: "Черновик", file });
    expect(chat.attempt).toMatchObject({ key, state: "unknown", text: "Черновик", reason: "Send failed" });
    expect(wrapper.get(".send-attempt").text()).toContain("Результат отправки неизвестен.");
    expect(wrapper.text()).toContain("report.pdf");
    // The same text and file again: the same attempt under its key.
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    const calls = api.mock.calls.filter(([path]) => path.endsWith("/send"));
    expect(calls.map(([, options]) => options?.key)).toEqual([key, key]);
    const sentFile = calls[1]![1]?.form?.get("file") as File;
    expect([sentFile.name, sentFile.type, await sentFile.text()]).toEqual([file.name, file.type, await file.text()]);
    expect(chat.draft).toEqual({ text: "", file: null });
    expect(chat.attempt).toBeNull();
    expect(wrapper.find(".attachment-preview").exists()).toBe(false);
    expect(wrapper.find(".send-attempt").exists()).toBe(false);
  });
});
