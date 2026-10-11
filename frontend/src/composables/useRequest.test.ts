import { mount } from "@vue/test-utils";
import { defineComponent, h, ref } from "vue";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { WINDOW_REQUESTS, useRequest } from "./useRequest";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

// A component with one request, inside a window that counts running requests (ui/ModalDialog).
function mountRequest() {
  const requests = ref(0);
  let request!: ReturnType<typeof useRequest>;
  const wrapper = mount(defineComponent({
    setup() {
      request = useRequest();
      return () => h("div");
    },
  }), { global: { provide: { [WINDOW_REQUESTS as symbol]: requests } } });
  return { request, requests, wrapper };
}

describe("a change sent from a form", () => {
  it("runs one request at a time, locks the window meanwhile and keeps the server's answer", async () => {
    const { request, requests, wrapper } = mountRequest();
    const first = deferred();
    let calls = 0;
    const running = request.run(async () => {
      calls++;
      await first.promise;
      return "Сохранено.";
    });
    expect([request.busy, requests.value]).toEqual([true, 1]);
    expect(await request.run(async () => { calls++; })).toBe(false);
    first.resolve();
    expect(await running).toBe(true);
    expect([calls, request.busy, request.status, request.failed, requests.value]).toEqual([1, false, "Сохранено.", false, 0]);

    expect(await request.run(async () => { throw new ApiError("Логин уже используется.", 409); })).toBe(false);
    expect([request.status, request.failed, requests.value]).toEqual(["Логин уже используется.", true, 0]);
    request.clear();
    expect([request.status, request.failed]).toEqual(["", false]);
    wrapper.unmount();
  });

  it("unlocks the window when its component goes away and applies nothing afterwards", async () => {
    const { request, requests, wrapper } = mountRequest();
    const pending = deferred();
    const running = request.run(() => pending.promise);
    expect(requests.value).toBe(1);
    wrapper.unmount();
    expect(requests.value).toBe(0);
    pending.reject(new ApiError("Ошибка сервера.", 500));
    expect(await running).toBe(false);
    expect([request.status, request.busy, requests.value]).toEqual(["", true, 0]);
  });
});
