import { createPinia, setActivePinia } from "pinia";
import { effectScope, nextTick, type EffectScope } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectsStore } from "../stores/projects";
import { useSessionStore } from "../stores/session";
import { useWorkspaceStore } from "../stores/workspace";
import {
  ACCESS_CHANGED, EVENTS_RETRY, POLL_WITH_EVENTS, POLL_WITHOUT_EVENTS, REFRESH_SPACING, useLiveUpdates,
} from "./useLiveUpdates";

const ACCOUNT = { id: "a1", login: "operator", name: "Оператор", role: "operator" as const, active: true, telegram_id: null };

class FakeEventSource {
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 1;
  closed = false;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data = "{}"): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data }));
  }
  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

describe("live updates", () => {
  let scope: EffectScope;
  let refresh: ReturnType<typeof vi.fn<() => Promise<void>>>;
  const latest = (): FakeEventSource => FakeEventSource.instances.at(-1)!;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const projects = [{ id: "p1", name: "Поддержка", active: true, admin_id: "a0", role: "operator", logo: null }];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(projects), { status: 200 })));
    FakeEventSource.instances = [];
    setActivePinia(createPinia());
    useSessionStore().signIn({ account: ACCOUNT, csrf: "c" });
    useProjectsStore().currentId = "p1";
    refresh = vi.fn<() => Promise<void>>(async () => undefined);
    useWorkspaceStore().refresh = refresh;
    scope = effectScope();
    scope.run(() => useLiveUpdates());
  });
  afterEach(() => {
    scope.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });

  it("opens one stream per project and polls every 3 s while it is not ready", async () => {
    expect(FakeEventSource.instances.map((source) => source.url)).toEqual(["/console/projects/p1/events"]);
    await vi.advanceTimersByTimeAsync(POLL_WITHOUT_EVENTS);
    await vi.advanceTimersByTimeAsync(POLL_WITHOUT_EVENTS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("refreshes on ready, then waits 30 s between polls", async () => {
    latest().emit("ready");
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_WITH_EVENTS - 1_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("merges a burst of change signals into one refresh", async () => {
    latest().emit("ready");
    await vi.advanceTimersByTimeAsync(100);
    for (let index = 0; index < 5; index++) latest().emit("change");
    await vi.advanceTimersByTimeAsync(REFRESH_SPACING);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("reopens a closed stream after 10 s and polls meanwhile", async () => {
    const first = latest();
    first.readyState = FakeEventSource.CLOSED;
    first.onerror?.();
    await vi.advanceTimersByTimeAsync(EVENTS_RETRY - 1_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(3);
    // The first poll after the retry time opens it again.
    await vi.advanceTimersByTimeAsync(1_000 + POLL_WITHOUT_EVENTS);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("a revoked stream ends the session on 401, otherwise drops the project with a notice", async () => {
    latest().emit("revoked", '{"status":403}');
    expect(useProjectsStore().currentId).toBeNull();
    expect(useWorkspaceStore().notice).toBe(ACCESS_CHANGED);
    await nextTick();
    expect(FakeEventSource.instances).toHaveLength(1);
    useProjectsStore().select("p1");
    await nextTick();
    latest().emit("revoked", '{"status":401}');
    expect(useSessionStore().status).toBe("signed-out");
  });

  it("stops while the tab is hidden and catches up when it is shown", async () => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(latest().closed).toBe(true);
    await vi.advanceTimersByTimeAsync(POLL_WITHOUT_EVENTS * 3);
    expect(refresh).not.toHaveBeenCalled();
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeEventSource.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(REFRESH_SPACING);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
