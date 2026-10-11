import { inject, onScopeDispose, reactive, ref, type InjectionKey, type Ref } from "vue";
import { FAILED } from "../stores/workspace";

/** Changes running inside a window (ui/ModalDialog): while any runs, Esc and the close button do nothing. */
export const WINDOW_REQUESTS: InjectionKey<Ref<number>> = Symbol("window requests");

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : FAILED;
}

/**
 * A change sent from a form or a button: one at a time (a repeated submit is ignored), the server's
 * answer for the status line, and nothing applied once the component is gone. A reactive object:
 * templates read `request.busy` directly.
 */
export function useRequest() {
  const busy = ref(false);
  /** The success text the action returned, or the error; `failed` tells which. */
  const status = ref("");
  const failed = ref(false);
  const requests = inject(WINDOW_REQUESTS, null);
  let active = true;
  let holding = false;

  function hold(on: boolean): void {
    if (!requests || holding === on) return;
    holding = on;
    requests.value += on ? 1 : -1;
  }

  async function run(action: () => Promise<string | void>): Promise<boolean> {
    if (busy.value) return false;
    busy.value = true;
    status.value = "";
    failed.value = false;
    hold(true);
    try {
      const done = await action();
      if (active) status.value = done ?? "";
      return true;
    } catch (error) {
      if (active) {
        status.value = errorMessage(error);
        failed.value = true;
      }
      return false;
    } finally {
      hold(false);
      if (active) busy.value = false;
    }
  }

  function clear(): void {
    status.value = "";
    failed.value = false;
  }

  onScopeDispose(() => {
    active = false;
    hold(false);
  });

  return reactive({ busy, status, failed, run, clear });
}
