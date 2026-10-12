import { onScopeDispose, ref } from "vue";

/** A success confirms a finished change; a warning needs the user's attention. */
export type NoticeKind = "success" | "warning";

export interface Notice {
  kind: NoticeKind;
  text: string;
  /** Tells a notice from an earlier one with the same text. */
  id: number;
}

/** How long a success stays on screen, in milliseconds. */
export const SUCCESS_DURATION = 3500;

/**
 * The feedback of one window: a success disappears by itself after SUCCESS_DURATION; a warning
 * stays until it is replaced or cleared. A newer notice gets the full time and is never removed by
 * the timer of an older one; the timer goes with the component.
 */
export function useNotice(duration = SUCCESS_DURATION) {
  const notice = ref<Notice | null>(null);
  let sequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function show(kind: NoticeKind, text: string): void {
    clearTimeout(timer);
    const id = ++sequence;
    notice.value = { kind, text, id };
    if (kind === "success") {
      timer = setTimeout(() => {
        if (notice.value?.id === id) notice.value = null;
      }, duration);
    }
  }

  /** Removes the notice, or only one of the given kind. */
  function clear(kind?: NoticeKind): void {
    if (kind && notice.value?.kind !== kind) return;
    clearTimeout(timer);
    notice.value = null;
  }

  onScopeDispose(() => clearTimeout(timer));

  return {
    notice,
    success: (text: string) => show("success", text),
    warning: (text: string) => show("warning", text),
    clear,
  };
}
