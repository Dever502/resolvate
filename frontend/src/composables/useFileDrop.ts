import { onScopeDispose, ref, type Ref } from "vue";

/** The drag's data when it carries files (from the computer or another app), or null for text and links. */
function draggedFiles(event: DragEvent): DataTransfer | null {
  const data = event.dataTransfer;
  return data && Array.from(data.types).includes("Files") ? data : null;
}

/**
 * How many files a drag carries, as far as the browser tells before the drop: until then it shows only
 * the kind and type of each item, not the files. Null when it tells nothing.
 */
function countFiles(data: DataTransfer): number | null {
  const count = Array.from(data.items ?? []).filter((item) => item.kind === "file").length;
  return count > 0 ? count : null;
}

export interface FileDropOptions {
  /** Why files cannot be dropped now (with their count, when known), or null when they can. */
  refusal: (count: number | null) => string | null;
  /** Takes the dropped files that nothing refused. */
  accept: (files: File[]) => void;
  /** Says why dropped files were not taken. */
  refuse: (reason: string) => void;
}

/**
 * Files dragged onto an element (chat/ConversationPanel.vue) with the browser's own drag events. Only a
 * drag that carries files is taken: text and links keep the browser's handling (text dropped into the
 * reply box goes there). A taken drag is never opened by the browser over the element, accepted or
 * refused: a refusal gets the "none" drop effect, and a drop that comes all the same is said, not used.
 *
 * `over` holds from the drag entering the element until it leaves, is cancelled, dropped or the scope
 * ends. The browser enters the node under the pointer before it leaves the previous one, so moving
 * between the element's children keeps it: only a dragleave of the node entered last ends it. A
 * dragover elsewhere in the page ends it too, for a node removed under the drag whose dragleave never
 * reached the element.
 */
export function useFileDrop(element: Readonly<Ref<HTMLElement | null>>, options: FileDropOptions) {
  const over = ref(false);
  const count = ref<number | null>(null);
  /** The node the drag entered last: its dragleave means the pointer left the element or the drag ended. */
  let entered: EventTarget | null = null;
  /** Why a drop that comes before the drag moves again is refused (see interrupt). */
  let interruption: string | null = null;

  const inside = (target: EventTarget | null): boolean => target instanceof Node && Boolean(element.value?.contains(target));

  function elsewhere(event: DragEvent): void {
    if (!inside(event.target)) end();
  }

  /** The drag is over for this element: it left, was cancelled or dropped, or the element is gone. */
  function end(): void {
    over.value = false;
    count.value = null;
    entered = null;
    interruption = null;
    window.removeEventListener("dragover", elsewhere, true);
  }

  /** dragenter and dragover: a drag with files is taken, whether its drop will be accepted or refused. */
  function take(event: DragEvent): void {
    const data = draggedFiles(event);
    if (!data) return;
    // The element takes the drag: its drop comes here, and the browser never opens the file instead.
    event.preventDefault();
    if (event.type === "dragenter" || !inside(entered)) entered = event.target;
    if (!over.value) window.addEventListener("dragover", elsewhere, true);
    over.value = true;
    interruption = null;
    count.value = countFiles(data);
    data.dropEffect = options.refusal(count.value) ? "none" : "copy";
  }

  function leave(event: DragEvent): void {
    if (draggedFiles(event) && event.target === entered) end();
  }

  function drop(event: DragEvent): void {
    const data = draggedFiles(event);
    if (!data) return;
    event.preventDefault();
    const interrupted = interruption;
    end();
    const files = Array.from(data.files);
    if (!files.length) return;
    const reason = interrupted ?? options.refusal(files.length);
    if (reason) options.refuse(reason);
    else options.accept(files);
  }

  /**
   * The element shows something else under the drag (another dialogue): the highlight goes, and a drop
   * that comes before the drag moves again is refused with `reason` instead of landing there unseen.
   */
  function interrupt(reason: string): void {
    if (!over.value) return;
    end();
    interruption = reason;
  }

  onScopeDispose(end);

  return {
    over: over as Readonly<Ref<boolean>>,
    count: count as Readonly<Ref<number | null>>,
    onDragEnter: take,
    onDragOver: take,
    onDragLeave: leave,
    onDrop: drop,
    onDragEnd: end,
    interrupt,
  };
}
