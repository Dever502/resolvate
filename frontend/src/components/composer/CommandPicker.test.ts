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
