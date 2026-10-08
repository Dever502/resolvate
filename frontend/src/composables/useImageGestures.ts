import { computed, ref, type Ref } from "vue";

export const MIN_SCALE = 1;
export const MAX_SCALE = 8;
export const ZOOM_STEP = 1.5;

interface Point {
  x: number;
  y: number;
}

/**
 * Zoom and pan of the image viewer (ported from the classic image_viewer.js): wheel and pinch zoom
 * around the pointer, drag to move a zoomed image, a click on the empty stage closes the viewer.
 * The transform is applied as a style object, which Vue sets through CSSOM under the console CSP.
 */
export function useImageGestures(stage: Ref<HTMLElement | null>, image: Ref<HTMLImageElement | null>, close: () => void) {
  const scale = ref(1);
  const x = ref(0);
  const y = ref(0);
  const pointers = new Map<number, Point>();
  let start: Point = { x: 0, y: 0 };
  let moved = false;
  let blankClick = false;

  const transform = computed(() => ({ transform: `translate(${x.value}px, ${y.value}px) scale(${scale.value})` }));
  const percent = computed(() => `${Math.round(scale.value * 100)}%`);
  const zoomed = computed(() => scale.value > 1);

  function clamp(): void {
    const box = stage.value;
    const picture = image.value;
    if (!box || !picture) return;
    const maxX = Math.max(0, (picture.clientWidth * scale.value - box.clientWidth) / 2);
    const maxY = Math.max(0, (picture.clientHeight * scale.value - box.clientHeight) / 2);
    x.value = Math.max(-maxX, Math.min(maxX, x.value));
    y.value = Math.max(-maxY, Math.min(maxY, y.value));
  }

  function reset(): void {
    scale.value = 1;
    x.value = 0;
    y.value = 0;
    pointers.clear();
  }

  function zoomBy(factor: number, point: Point = { x: 0, y: 0 }): void {
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale.value * factor));
    const ratio = next / scale.value;
    x.value = point.x - (point.x - x.value) * ratio;
    y.value = point.y - (point.y - y.value) * ratio;
    scale.value = next;
    clamp();
  }

  /** A point relative to the centre of the stage. */
  function point(event: { clientX: number; clientY: number }): Point {
    const box = stage.value!.getBoundingClientRect();
    return { x: event.clientX - box.left - box.width / 2, y: event.clientY - box.top - box.height / 2 };
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    zoomBy(Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.01), point(event));
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    stage.value?.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, point(event));
    blankClick = event.target === stage.value && pointers.size === 1;
    moved = false;
    start = point(event);
  }

  function onPointerMove(event: PointerEvent): void {
    const old = pointers.get(event.pointerId);
    if (!old) return;
    const before = [...pointers.values()];
    const now = point(event);
    pointers.set(event.pointerId, now);
    if (Math.hypot(now.x - start.x, now.y - start.y) > 4) moved = true;
    if (pointers.size === 2) {
      const after = [...pointers.values()];
      const center = (pair: Point[]): Point => ({ x: (pair[0]!.x + pair[1]!.x) / 2, y: (pair[0]!.y + pair[1]!.y) / 2 });
      const distance = (pair: Point[]): number => Math.hypot(pair[0]!.x - pair[1]!.x, pair[0]!.y - pair[1]!.y);
      const a = center(before);
      const b = center(after);
      zoomBy(distance(after) / Math.max(1, distance(before)), a);
      x.value += b.x - a.x;
      y.value += b.y - a.y;
      blankClick = false;
    } else if (pointers.size === 1 && scale.value > 1) {
      x.value += now.x - old.x;
      y.value += now.y - old.y;
    }
    clamp();
  }

  function onPointerEnd(event: PointerEvent): void {
    if (!pointers.has(event.pointerId)) return;
    const closing = event.type === "pointerup" && blankClick && !moved && pointers.size === 1;
    pointers.delete(event.pointerId);
    blankClick = false;
    if (closing) close();
  }

  /** "+", "=", "-" zoom; "0" fits the image again. */
  function onKeyDown(event: KeyboardEvent): void {
    if (!["+", "=", "-", "0"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "0") reset();
    else zoomBy(event.key === "-" ? 1 / ZOOM_STEP : ZOOM_STEP);
  }

  return {
    scale, transform, percent, zoomed, reset, zoomBy, clamp,
    onWheel, onPointerDown, onPointerMove, onPointerEnd, onKeyDown,
  };
}
