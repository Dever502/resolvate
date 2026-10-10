import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { TooltipProvider } from "reka-ui";
import { h } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../../stores/chat";
import { useProjectsStore } from "../../stores/projects";
import { useSessionStore } from "../../stores/session";
import Composer from "./Composer.vue";

const renderComposer = () => mount(TooltipProvider, { slots: { default: () => h(Composer) } });

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
