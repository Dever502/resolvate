import { mount, flushPromises, enableAutoUnmount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { receiptKey } from "../../lib/commandAttempt";
import { useChatStore } from "../../stores/chat";
import { useProjectsStore } from "../../stores/projects";
import { useSessionStore } from "../../stores/session";
import CommandPicker from "./CommandPicker.vue";

enableAutoUnmount(afterEach);
const account = { id: "a", name: "Operator", login: "operator", role: "operator" as const, active: true, telegram_id: null };
const catalog = [
  { name: "note", description: "Заметка", arguments: "<текст>", mutation: true },
  { name: "info", description: "Информация", arguments: "", mutation: false },
  { name: "gift", description: "Продлить подписку", arguments: "<дни>", mutation: true },
];
const RECEIPT = receiptKey("a:p1:t1");
beforeEach(() => {
  setActivePinia(createPinia());
  sessionStorage.clear();
  document.body.innerHTML = "";
  useSessionStore().signIn({ account, csrf: "c" });
  useProjectsStore().currentId = "p1";
  useChatStore().ticketId = "t1";
  useChatStore().drafts.set("t1", { text: "/note private", files: [] });
});
afterEach(() => vi.restoreAllMocks());

/** The API: the catalog, and each command answered by `answer`. */
function api(answer: (path: string, options: { key?: string }) => unknown) {
  return vi.spyOn(useSessionStore(), "api").mockImplementation(async (path, options = {}) => {
    if (path === "commands") return catalog;
    const value = answer(path, options as { key?: string });
    if (value instanceof Error) throw value;
    return value;
  });
}
const posts = (spy: ReturnType<typeof api>) => spy.mock.calls.filter(([path]) => path !== "commands");
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
it("a definitive retry rejection clears the unknown state and permits a new attempt", async () => {
  let count = 0;
  const spy = api(() => ++count === 1 ? new ApiError("Нет связи", 0) : new ApiError("Запрещено", 403));
  const wrapper = mount(CommandPicker, { props: { text: "/note private", hasFiles: false } });
  await flushPromises();
  await wrapper.vm.execute();
  await flushPromises();
  expect(wrapper.find(".command-unknown").exists()).toBe(true);
  await wrapper.vm.execute();
  await flushPromises();
  expect(sessionStorage.getItem(RECEIPT)).toBeNull();
  expect(wrapper.find(".command-unknown").exists()).toBe(false);
  expect(wrapper.get('[data-kind="rejected"]').text()).toContain("Запрещено");
  await wrapper.vm.execute();
  expect(posts(spy)[1]![1]?.key).toBe(posts(spy)[0]![1]?.key);
  expect(posts(spy)[2]![1]?.key).not.toBe(posts(spy)[0]![1]?.key);
});

it.each(["completed", "rejected"])("a late %s response preserves a newer receipt in the same dialogue", async (outcome) => {
  let finish!: (value: unknown) => void;
  let reject!: (cause: unknown) => void;
  api(() => new Promise((resolve, fail) => { finish = resolve; reject = fail; }));
  const wrapper = mount(CommandPicker, { props: { text: "/note private", hasFiles: false } });
  await flushPromises();
  const request = wrapper.vm.execute();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  // A component can go away while its request is pending; a later instance owns a new attempt.
  wrapper.unmount();
  const replacement = JSON.stringify({ key: "new-attempt", fingerprint: "new-fingerprint", command: "note", arguments: null });
  sessionStorage.setItem(RECEIPT, replacement);
  if (outcome === "completed") finish({ status: "completed", message: "Готово" });
  else reject(new ApiError("Запрещено", 403));
  await request;
  expect(sessionStorage.getItem(RECEIPT)).toBe(replacement);
});
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label);

it("attachments prevent command execution without altering the draft", async () => {
  const spy = api(() => ({ status: "completed", message: "x" }));
  const wrapper = mount(CommandPicker, { props: { text: "/note private", hasFiles: true } });
  await flushPromises();
  await wrapper.vm.execute();
  expect(posts(spy)).toHaveLength(0);
  expect(wrapper.get('[role="alert"]').text()).toContain("уберите вложения");
  expect(useChatStore().draft?.text).toBe("/note private");
});

it("a format error sends nothing and keeps the text for fixing", async () => {
  const spy = api(() => ({ status: "completed", message: "x" }));
  const wrapper = mount(CommandPicker, { props: { text: "/gift 0", hasFiles: false } });
  await flushPromises();
  await wrapper.vm.execute();
  expect(posts(spy)).toHaveLength(0);
  expect(wrapper.get('[role="alert"][data-kind="format"]').text()).toBe("Формат: /gift <дни>");
  expect(wrapper.emitted("insert")).toBeUndefined();
});

it("a lost answer keeps the key for the same command, blocks another change, and a damaged key fails closed", async () => {
  const spy = api(() => new ApiError("Нет связи", 0));
  const wrapper = mount(CommandPicker, { props: { text: "/note private", hasFiles: false } });
  await flushPromises();
  await wrapper.vm.execute();
  await flushPromises();
  expect(wrapper.get(".command-unknown").text()).toContain("Результат /note неизвестен");
  expect(sessionStorage.getItem(RECEIPT)).not.toContain("private");
  await wrapper.vm.execute();
  await flushPromises();
  expect(posts(spy)).toHaveLength(2);
  expect(posts(spy)[0]![1]?.key).toBe(posts(spy)[1]![1]?.key);
  expect(useChatStore().sending).toBe(false);
  // Another changing command waits for this one.
  await wrapper.setProps({ text: "/note другое" });
  await wrapper.vm.execute();
  await flushPromises();
  expect(posts(spy)).toHaveLength(2);
  expect(wrapper.get('[role="alert"][data-kind="local"]').text()).toContain("результат предыдущей неизвестен");
  sessionStorage.setItem(RECEIPT, "broken json");
  await wrapper.vm.execute();
  expect(posts(spy)).toHaveLength(2);
  expect(wrapper.get('[role="alert"]').text()).toContain("Выполнение отменено");
});

it("the key is kept before the request leaves; a completed change frees the next one and leaves the box", async () => {
  let storedAtRequest: string | null = null;
  const spy = api((_path, options) => {
    storedAtRequest = sessionStorage.getItem(RECEIPT);
    expect(storedAtRequest).toContain(options.key!);
    return { status: "completed", message: "Заметка добавлена." };
  });
  const wrapper = mount(CommandPicker, { props: { text: "/note private", hasFiles: false }, attachTo: document.body });
  await flushPromises();
  await wrapper.vm.execute();
  await flushPromises();
  expect(storedAtRequest).not.toBeNull();
  expect(sessionStorage.getItem(RECEIPT)).toBeNull();
  // The command leaves the box: the parent clears the draft.
  expect(wrapper.emitted("insert")).toEqual([[""]]);
  // A short answer of a change is a notice, not a result to read.
  expect(wrapper.get(".command-toast-region").text()).toContain("Заметка добавлена.");
  expect(wrapper.find('[data-filled]').exists()).toBe(false);
  // The next change runs at once: no «Новая команда».
  await wrapper.setProps({ text: "/note ещё одна" });
  await wrapper.vm.execute();
  await flushPromises();
  expect(posts(spy)).toHaveLength(2);
  expect(posts(spy)[0]![1]?.key).not.toBe(posts(spy)[1]![1]?.key);
  expect(wrapper.text()).not.toContain("Новая команда");
});

it("a completed command does not clear what the operator typed meanwhile", async () => {
  let finish!: (value: unknown) => void;
  api(() => new Promise(resolve => { finish = resolve; }));
  const wrapper = mount(CommandPicker, { props: { text: "/info", hasFiles: false } });
  await flushPromises();
  const running = wrapper.vm.execute();
  await flushPromises();
  await wrapper.setProps({ text: "Здравствуйте, уже проверяю" });
  finish({ status: "completed", message: "Клиент: Анна" });
  await running;
  await flushPromises();
  expect(wrapper.emitted("insert")).toBeUndefined();
  expect(wrapper.get('[aria-label="Результат команды"]').text()).toBe("Клиент: Анна");
});

it("a refusal before the key is reserved frees it and says why; an answer «unknown» is not a success", async () => {
  let answer: unknown = new ApiError("Команда недоступна в этом проекте.", 403);
  const spy = api(() => answer);
  const wrapper = mount(CommandPicker, { props: { text: "/note private", hasFiles: false } });
  await flushPromises();
  await wrapper.vm.execute();
  await flushPromises();
  expect(wrapper.get('[data-kind="rejected"]').text()).toBe("Команда недоступна в этом проекте.");
  expect(sessionStorage.getItem(RECEIPT)).toBeNull();
  answer = { status: "unknown", message: "Команда выполняется или её результат неизвестен." };
  await wrapper.setProps({ text: "/note private." });
  await wrapper.vm.execute();
  await flushPromises();
  expect(wrapper.get(".command-unknown").text()).toContain("Команда выполняется или её результат неизвестен.");
  expect(sessionStorage.getItem(RECEIPT)).not.toBeNull();
  expect(wrapper.emitted("insert")).toBeUndefined();
  answer = new ApiError("Ошибка сервера", 502);
  await wrapper.vm.execute();
  await flushPromises();
  expect(sessionStorage.getItem(RECEIPT)).not.toBeNull();
  expect(posts(spy)[1]![1]?.key).toBe(posts(spy)[2]![1]?.key);
});

it("two submits at once send one request", async () => {
  let finish!: (value: unknown) => void;
  const spy = api(() => new Promise(resolve => { finish = resolve; }));
  const wrapper = mount(CommandPicker, { props: { text: "/note private", hasFiles: false } });
  await flushPromises();
  const first = wrapper.vm.execute();
  const second = wrapper.vm.execute();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await wrapper.vm.execute();
  finish({ status: "completed", message: "Заметка добавлена." });
  await Promise.all([first, second]);
  expect(posts(spy)).toHaveLength(1);
});

it("a change with consequences asks first: cancel sends nothing, confirm sends once, in its own dialogue", async () => {
  const spy = api(() => ({ status: "completed", message: "Подписка продлена." }));
  const wrapper = mount(CommandPicker, { props: { text: "/gift 30", hasFiles: false }, attachTo: document.body });
  await flushPromises();
  await wrapper.vm.execute();
  await flushPromises();
  expect(dialog()?.textContent).toContain("Продлить подписку?");
  expect(dialog()?.textContent).toContain("на 30 дней");
  expect(posts(spy)).toHaveLength(0);
  button("Отмена")!.click();
  await flushPromises();
  expect(dialog()).toBeNull();
  expect(posts(spy)).toHaveLength(0);
  expect(sessionStorage.getItem(RECEIPT)).toBeNull();

  await wrapper.vm.execute();
  await flushPromises();
  button("Продлить на 30 дней")!.click();
  button("Продлить на 30 дней")?.click();
  await vi.waitFor(() => {
    expect(posts(spy)).toHaveLength(1);
    expect(dialog()).toBeNull();
  });
  expect(posts(spy)[0]![1]).toMatchObject({ data: { arguments: "30" } });
  expect(sessionStorage.getItem(RECEIPT)).toBeNull();

  // Asked in one dialogue, never run in another.
  await wrapper.setProps({ text: "/gift 60" });
  await wrapper.vm.execute();
  await flushPromises();
  expect(dialog()?.textContent).toContain("на 60 дней");
  useChatStore().ticketId = "t2";
  await flushPromises();
  expect(dialog()).toBeNull();
  expect(posts(spy)).toHaveLength(1);
});

it("an old command response cannot unlock a new account's send", async () => {
  let finish!: (value: unknown) => void;
  api(() => new Promise(resolve => { finish = resolve; }));
  const wrapper = mount(CommandPicker, { props: { text: "/note private", hasFiles: false } });
  await flushPromises();
  const running = wrapper.vm.execute();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  useSessionStore().signOut();
  useSessionStore().signIn({ account: { ...account, id: "other" }, csrf: "new" });
  useChatStore().sending = true;
  finish({ status: "completed", message: "Private result" });
  await running;
  expect(useChatStore().sending).toBe(true);
  expect(wrapper.text()).not.toContain("Private result");
});

it("a receipt left from before (a reload) shows its unknown outcome and repeats it with its key", async () => {
  sessionStorage.setItem(RECEIPT, JSON.stringify({ fingerprint: "f", key: "11111111-1111-4111-8111-111111111111", command: "gift", arguments: "30" }));
  const spy = api(() => ({ status: "completed", message: "Подписка продлена." }));
  const wrapper = mount(CommandPicker, { props: { text: "", hasFiles: false } });
  await flushPromises();
  expect(wrapper.get(".command-unknown").text()).toContain("Результат /gift 30 неизвестен");
  await wrapper.get(".command-actions button").trigger("click");
  await flushPromises();
  expect(posts(spy)).toHaveLength(1);
  expect(posts(spy)[0]![1]).toMatchObject({ key: "11111111-1111-4111-8111-111111111111", data: { arguments: "30" } });
  expect(sessionStorage.getItem(RECEIPT)).toBeNull();
  expect(wrapper.find(".command-unknown").exists()).toBe(false);
});

it("every state of a command is inside the pop-up over the reply box, none in the reply area's flow", async () => {
  api(() => ({ status: "completed", message: "Готово" }));
  const wrapper = mount(CommandPicker, { props: { text: "/info", hasFiles: false }, attachTo: document.body });
  await flushPromises();
  // The component's own box is none (display: contents): its parts are positioned in the reply area.
  expect(wrapper.element.classList.contains("command-layer")).toBe(true);
  const pop = () => wrapper.get(".reply-options");
  expect(pop().get(".command-hint").text()).toContain("/info — Информация");
  await wrapper.vm.execute();
  await flushPromises();
  expect(pop().get('[role="status"][aria-label="Результат команды"]').text()).toBe("Готово");
  expect(pop().get(".command-result-title").text()).toBe("Результат /info");
  await wrapper.setProps({ text: "/gift x" });
  await wrapper.vm.execute();
  await flushPromises();
  expect(pop().get('[role="alert"]').text()).toContain("Формат");
});

it("Escape without the list puts the pop-up away and keeps the text; a new error brings it back", async () => {
  api(() => ({ status: "completed", message: "x" }));
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
  api(() => ({ status: "completed", message: "Только для оператора" }));
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

it("a key that cannot be kept sends nothing", async () => {
  const spy = api(() => ({ status: "completed", message: "Заметка добавлена." }));
  const wrapper = mount(CommandPicker, { props: { text: "/note private", hasFiles: false } });
  await flushPromises();
  vi.spyOn(sessionStorage, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
  await wrapper.vm.execute();
  await flushPromises();
  expect(posts(spy)).toHaveLength(0);
  expect(wrapper.get('[role="alert"][data-kind="local"]').text()).toContain("Не удалось сохранить ключ команды");
  expect(wrapper.emitted("insert")).toBeUndefined();
});
