import { effectScope } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUCCESS_DURATION, useNotice } from "./useNotice";

describe("useNotice", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a success disappears by itself; a newer one gets the full time and survives the older timer", () => {
    const scope = effectScope();
    const notices = scope.run(() => useNotice())!;
    notices.success("Ответ удалён.");
    expect(notices.notice.value).toMatchObject({ kind: "success", text: "Ответ удалён." });
    vi.advanceTimersByTime(SUCCESS_DURATION - 1000);
    notices.success("Ответ сохранён.");
    // The first timer would have fired here.
    vi.advanceTimersByTime(1500);
    expect(notices.notice.value).toMatchObject({ text: "Ответ сохранён." });
    vi.advanceTimersByTime(SUCCESS_DURATION - 1500);
    expect(notices.notice.value).toBeNull();
    scope.stop();
  });

  it("a warning stays until it is replaced or cleared, and stops a pending success timer", () => {
    const scope = effectScope();
    const notices = scope.run(() => useNotice())!;
    notices.success("Ответ удалён.");
    notices.warning("Группы /оплата больше нет: её удалил другой оператор.");
    vi.advanceTimersByTime(SUCCESS_DURATION * 10);
    expect(notices.notice.value).toMatchObject({ kind: "warning" });
    // Clearing successes only leaves the warning; clearing warnings removes it.
    notices.clear("success");
    expect(notices.notice.value?.kind).toBe("warning");
    notices.clear("warning");
    expect(notices.notice.value).toBeNull();
    scope.stop();
  });

  it("clears its timer with the component", () => {
    const scope = effectScope();
    const notices = scope.run(() => useNotice())!;
    notices.success("Группа /vpn создана.");
    expect(vi.getTimerCount()).toBe(1);
    scope.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
