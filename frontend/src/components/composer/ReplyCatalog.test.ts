import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuickReply, QuickReplyGroup } from "../../api/types";
import { useSessionStore } from "../../stores/session";
import ReplyCatalog from "./ReplyCatalog.vue";

enableAutoUnmount(afterEach);

type Answer = QuickReply[] | QuickReplyGroup[] | Promise<unknown>;

/** The catalog API by path: `answer(kind, query)` gives the rows (groups or replies). */
function serve(answer: (kind: string, query: URLSearchParams) => Answer) {
  return vi.spyOn(useSessionStore(), "api").mockImplementation(async (path: string) => {
    const url = new URL(path, "http://catalog/");
    return answer(url.pathname.slice(1), url.searchParams);
  });
}

function open() {
  mount(ReplyCatalog, { props: { projectId: "p1", open: true, "onUpdate:open": () => undefined }, attachTo: document.body });
}

async function type(text: string): Promise<void> {
  const field = document.body.querySelector<HTMLInputElement>('input[aria-label="Поиск в каталоге"]')!;
  field.value = text;
  field.dispatchEvent(new Event("input"));
  await vi.advanceTimersByTimeAsync(250);
  await flushPromises();
}

describe("quick replies catalog", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useSessionStore().signIn({ account: { id: "a", name: "Operator", login: "operator", role: "operator",
      active: true, telegram_id: null }, csrf: "c" });
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("drops a slower answer to an older search", async () => {
    let finish!: (rows: QuickReply[]) => void;
    const slow = new Promise<unknown>((resolve) => { finish = resolve; });
    serve((kind, query) => {
      const q = query.get("q") ?? "";
      if (kind === "reply-groups") return q ? [] : [{ id: "g1", name: "общее", revision: 0 }];
      if (query.has("group_id")) return [];
      if (q === "ста") return slow;
      return q === "стар" ? [{ id: "2", text: "Новый ответ на старый вопрос", group_id: "g1", revision: 0 }] : [];
    });
    open();
    await flushPromises();
    await type("ста");
    await type("стар");
    expect(document.body.textContent).toContain("Новый ответ на старый вопрос");
    finish([{ id: "1", text: "Устаревший результат", group_id: "g1", revision: 0 }]);
    await flushPromises();
    expect(document.body.textContent).not.toContain("Устаревший результат");
    expect(document.body.textContent).toContain("Новый ответ на старый вопрос");
  });

  it("names the group of every search result, even one beyond the loaded page of groups", async () => {
    const first = Array.from({ length: 50 }, (_, index) => ({ id: `g${index}`, name: `группа_${index}`, revision: 0 }));
    const api = serve((kind, query) => {
      const q = query.get("q") ?? "";
      if (kind === "reply-groups" && q) return [];
      if (kind === "reply-groups") return query.get("offset") === "50" ? [{ id: "g99", name: "общее", revision: 0 }] : first;
      if (query.has("group_id")) return [];
      return [{ id: "7", text: "Ответ из дальней группы", group_id: "g99", revision: 0 }];
    });
    open();
    await flushPromises();
    await type("дальн");
    const label = document.body.querySelector('[aria-label="Открыть группу #общее"]');
    expect(label?.textContent).toBe("#общее");
    expect(api.mock.calls.map(([path]) => path)).toContain("reply-groups?q=&offset=50");
  });
});
