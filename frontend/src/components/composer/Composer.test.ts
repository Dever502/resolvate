import { mount, flushPromises, enableAutoUnmount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { TooltipProvider } from "reka-ui";
import { h, toRaw } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FILE_BYTES, useChatStore } from "../../stores/chat";
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
    chat.drafts.set("t1", { text: "", file: null, key: null });
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
});

describe("composer attachments", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useProjectsStore().currentId = "p1";
    const chat = useChatStore();
    chat.ticketId = "t1";
    chat.drafts.set("t1", { text: "Черновик", file: null, key: "previous-key" });
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

  it("selects, replaces and removes without changing text; edits clear the idempotency key", async () => {
    const wrapper = renderComposer();
    const chat = useChatStore();
    await attach(wrapper, pdf());
    expect(wrapper.text()).toContain("report.pdf");
    expect(chat.draft?.key).toBeNull();
    const replacement = pdf("new.pdf");
    await attach(wrapper, replacement);
    expect(wrapper.text()).not.toContain("report.pdf");
    expect(toRaw(chat.draft?.file)).toBe(replacement);
    await wrapper.get('[aria-label="Убрать вложение"]').trigger("click");
    expect(wrapper.find(".attachment-preview").exists()).toBe(false);
    expect(chat.draft).toEqual({ text: "Черновик", file: null, key: null });
  });

  it("keeps the previous file and key when replacement exceeds 20 MiB", async () => {
    const wrapper = renderComposer();
    const valid = pdf();
    Object.defineProperty(valid, "size", { value: MAX_FILE_BYTES });
    await attach(wrapper, valid);
    const chat = useChatStore();
    chat.draft!.key = "retry-key";
    const large = pdf("too-large.pdf");
    Object.defineProperty(large, "size", { value: MAX_FILE_BYTES + 1 });
    await attach(wrapper, large);
    expect(toRaw(chat.draft?.file)).toBe(valid);
    expect(chat.draft?.key).toBe("retry-key");
    expect(wrapper.text()).toContain("report.pdf");
    expect(wrapper.text()).not.toContain("too-large.pdf");
  });

  it("restores the dialogue's attachment and drops previews on reset", async () => {
    const wrapper = renderComposer();
    const chat = useChatStore();
    await attach(wrapper, pdf("anna.pdf"));
    chat.drafts.set("t2", { text: "Другой текст", file: pdf("boris.pdf"), key: "retry" });
    chat.ticketId = "t2";
    await flushPromises();
    expect(wrapper.text()).toContain("boris.pdf");
    expect(wrapper.text()).not.toContain("anna.pdf");
    expect(chat.draft?.key).toBe("retry");
    chat.ticketId = "t1";
    await flushPromises();
    expect(wrapper.text()).toContain("anna.pdf");
    expect(wrapper.get("textarea").element.value).toBe("Черновик");
    chat.reset();
    await flushPromises();
    expect(wrapper.find(".attachment-preview").exists()).toBe(false);
  });

  it("keeps attachment and key on failure, disables controls while sending, clears on success", async () => {
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
    const key = chat.draft!.key;
    expect(key).toBeTruthy();
    expect(wrapper.get('[aria-label="Убрать вложение"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[aria-label="Прикрепить файл"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get("textarea").attributes("disabled")).toBeDefined();
    reject(new Error("Send failed"));
    await flushPromises();
    expect(chat.draft).toEqual({ text: "Черновик", file, key });
    expect(wrapper.text()).toContain("report.pdf");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    const calls = api.mock.calls.filter(([path]) => path.endsWith("/send"));
    expect(calls.map(([, options]) => options?.key)).toEqual([key, key]);
    const sentFile = calls[1]![1]?.form?.get("file") as File;
    expect([sentFile.name, sentFile.type, await sentFile.text()]).toEqual([file.name, file.type, await file.text()]);
    expect(chat.draft).toEqual({ text: "", file: null, key: null });
    expect(wrapper.find(".attachment-preview").exists()).toBe(false);
  });
});
