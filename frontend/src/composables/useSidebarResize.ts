import { computed, onMounted, onScopeDispose, ref, type Ref } from "vue";

/** Same key as the classic console: a browser-local layout preference, not an account setting. */
export const SIDEBAR_KEY = "resolvate.sidebar-width";
const NARROW = 700;

function readPreferred(): number | null {
  try {
    const saved = Number(localStorage.getItem(SIDEBAR_KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : null;
  } catch {
    return null; // Storage may be unavailable in a private or restricted context.
  }
}

function writePreferred(value: number | null): void {
  try {
    if (value === null) localStorage.removeItem(SIDEBAR_KEY);
    else localStorage.setItem(SIDEBAR_KEY, String(value));
  } catch {
    // Resizing still works without persistence.
  }
}

/**
 * Width of the ticket list between the --sidebar-width token and a third of the window. Drag the
 * separator, use arrows (Shift: larger steps), Home and End; a double click returns to the default.
 */
export function useSidebarResize(sidebar: Ref<HTMLElement | null>) {
  const preferred = ref(readPreferred());
  const limits = ref({ min: 0, max: 0 });
  const viewport = ref(0);
  const dragging = ref(false);
  let drag: { id: number; x: number; width: number; handle: HTMLElement } | null = null;

  function measure(): void {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    const min = parseFloat(style.getPropertyValue("--sidebar-width")) * parseFloat(style.fontSize);
    viewport.value = root.clientWidth;
    limits.value = { min, max: Math.max(min, root.clientWidth / 3) };
  }

  const width = computed(() => {
    const { min, max } = limits.value;
    return Math.min(max, Math.max(min, preferred.value ?? min));
  });
  const disabled = computed(() => viewport.value <= NARROW || limits.value.max <= limits.value.min);
  /** Applied as a CSS custom property through CSSOM, which the console CSP allows. */
  const style = computed(() => ({ "--sidebar-preferred-width": `${width.value}px` }));

  function setWidth(value: number): void {
    const { min, max } = limits.value;
    preferred.value = Math.min(max, Math.max(min, value));
  }

  function finish(event?: PointerEvent): void {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    if (drag.handle.hasPointerCapture(drag.id)) drag.handle.releasePointerCapture(drag.id);
    drag = null;
    dragging.value = false;
    writePreferred(preferred.value);
  }

  function onPointerDown(event: PointerEvent): void {
    if (!event.isPrimary || event.button !== 0 || disabled.value) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.focus({ preventScroll: true });
    drag = { id: event.pointerId, x: event.clientX, width: sidebar.value?.getBoundingClientRect().width ?? width.value, handle };
    handle.setPointerCapture(event.pointerId);
    dragging.value = true;
  }

  function onPointerMove(event: PointerEvent): void {
    if (drag && event.pointerId === drag.id) setWidth(drag.width + event.clientX - drag.x);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (disabled.value) return;
    const { min, max } = limits.value;
    const current = sidebar.value?.getBoundingClientRect().width ?? width.value;
    const step = event.shiftKey ? 40 : 10;
    const values: Record<string, number> = { ArrowLeft: current - step, ArrowRight: current + step, Home: min, End: max };
    const next = values[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setWidth(next);
    writePreferred(preferred.value);
  }

  function onDoubleClick(): void {
    preferred.value = null;
    writePreferred(null);
  }

  function onResize(): void {
    finish();
    measure();
  }
  function onBlur(): void {
    finish();
  }

  onMounted(measure);
  window.addEventListener("resize", onResize);
  window.addEventListener("blur", onBlur);
  onScopeDispose(() => {
    window.removeEventListener("resize", onResize);
    window.removeEventListener("blur", onBlur);
  });

  return {
    width, limits, disabled, dragging, style,
    onPointerDown, onPointerMove, onPointerEnd: finish, onKeyDown, onDoubleClick,
  };
}
