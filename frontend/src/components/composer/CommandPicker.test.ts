import { mount, flushPromises, enableAutoUnmount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { useChatStore } from "../../stores/chat";
import { useProjectsStore } from "../../stores/projects";
import { useSessionStore } from "../../stores/session";
import CommandPicker from "./CommandPicker.vue";

enableAutoUnmount(afterEach);
const account = { id: "a", name: "Operator", login: "operator", role: "operator" as const, active: true, telegram_id: null };
const catalog = [{ name: "note", description: "Заметка", arguments: "<текст>", mutation: true }];
beforeEach(() => {
  setActivePinia(createPinia());
  sessionStorage.clear();
  useSessionStore().signIn({ account, csrf: "c" });
  useProjectsStore().currentId = "p1";
  useChatStore().ticketId = "t1";
  useChatStore().drafts.set("t1", { text: "/note private", files: [] });
});
afterEach(() => vi.restoreAllMocks());

it("attachments prevent command execution without altering the draft", async () => {
  const api = vi.spyOn(useSessionStore(), "api").mockResolvedValue(catalog);
  const wrapper = mount(CommandPicker, { props: { text: "/note private", hasFiles: true } });
  await flushPromises();
  await wrapper.vm.execute();
  expect(api).toHaveBeenCalledTimes(1);
  expect(wrapper.get('[role="alert"]').text()).toContain("уберите вложения");
  expect(useChatStore().draft?.text).toBe("/note private");
});

it("lost responses preserve the key and corrupt storage fails closed", async () => {
  const api = vi.spyOn(useSessionStore(), "api").mockImplementation(async path => {
    if (path === "commands") return catalog;
    throw new ApiError("Нет связи", 0);
  });
  const wrapper = mount(CommandPicker, { props: { text: "/note private", hasFiles: false } });
  await flushPromises();
  await wrapper.vm.execute();
  await wrapper.vm.execute();
  const calls = api.mock.calls.filter(([path]) => path !== "commands");
  expect(calls).toHaveLength(2);
  expect(calls[0]![1]?.key).toBe(calls[1]![1]?.key);
  expect(useChatStore().sending).toBe(false);
  const key = "resolvate.command:a:p1:t1";
  expect(sessionStorage.getItem(key)).not.toContain("private");
  sessionStorage.setItem(key, "broken json");
  await wrapper.vm.execute();
  expect(api.mock.calls.filter(([path]) => path !== "commands")).toHaveLength(2);
  expect(wrapper.get('[role="alert"]').text()).toContain("Выполнение отменено");
});

it("an old command response cannot unlock a new account's send", async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  vi.spyOn(useSessionStore(), "api").mockImplementation(async path => path === "commands" ? catalog : pending);
  const wrapper = mount(CommandPicker, { props: { text: "/note private", hasFiles: false } });
  await flushPromises();
  const running = wrapper.vm.execute();
  await vi.waitFor(() => expect(useChatStore().sending).toBe(true));
  useSessionStore().signOut();
  useSessionStore().signIn({ account: { ...account, id: "other" }, csrf: "new" });
  useChatStore().sending = true;
  finish({ status: "completed", message: "Private result" });
  await running;
  expect(useChatStore().sending).toBe(true);
  expect(wrapper.text()).not.toContain("Private result");
});

it("every state of a command is inside the pop-up over the reply box, none in the reply area's flow", async () => {
  vi.spyOn(useSessionStore(), "api").mockImplementation(async path => path === "commands" ? catalog : { status: "completed", message: "Готово" });
  const wrapper = mount(CommandPicker, { props: { text: "/note private", hasFiles: false }, attachTo: document.body });
  await flushPromises();
  // The component renders the pop-up only: the hint, an error and a result are inside it.
  const pop = () => wrapper.get(".reply-options");
  expect(wrapper.html().trimStart()).toMatch(/^<div class="reply-options command-options"/);
  expect(pop().get(".command-hint").text()).toContain("/note <текст> — Заметка");
  await wrapper.vm.execute();
  await flushPromises();
  expect(pop().get('[role="status"][aria-label="Результат команды"]').text()).toBe("Готово");
  await wrapper.setProps({ text: "/note" });
  await wrapper.setProps({ text: "/note " });
  await wrapper.vm.execute();
  await flushPromises();
  expect(pop().get('[role="alert"]').text()).toContain("Формат");
});

it("Escape without the list puts the pop-up away and keeps the text; a new error brings it back", async () => {
  vi.spyOn(useSessionStore(), "api").mockResolvedValue(catalog);
  const wrapper = mount(CommandPicker, { props: { text: "/note ", hasFiles: false } });
  await flushPromises();
  expect(wrapper.find(".reply-options").exists()).toBe(true);
  const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
  expect(wrapper.vm.keydown(escape)).toBe(true);
  expect(escape.defaultPrevented).toBe(true);
  await flushPromises();
  expect(wrapper.find(".reply-options").exists()).toBe(false);
  expect(useChatStore().draft?.text).toBe("/note private");
  await wrapper.vm.execute();
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain("Формат");
});

it("a tap outside puts the list away but keeps a result", async () => {
  vi.spyOn(useSessionStore(), "api").mockImplementation(async path => path === "commands"
    ? [{ name: "info", description: "Информация", arguments: "", mutation: false }]
    : { status: "completed", message: "Только для оператора" });
  const wrapper = mount(CommandPicker, { props: { text: "/info", hasFiles: false }, attachTo: document.body });
  await flushPromises();
  expect(wrapper.find('[role="listbox"]').exists()).toBe(true);
  await wrapper.vm.execute();
  await flushPromises();
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  await flushPromises();
  expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
  expect(wrapper.get('[aria-label="Результат команды"]').text()).toBe("Только для оператора");
});
