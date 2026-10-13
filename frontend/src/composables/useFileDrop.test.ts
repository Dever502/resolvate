import { effectScope, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFileDrop } from "./useFileDrop";

// happy-dom has no DragEvent, and its DataTransfer does not list "Files" among the types: each event
// carries a stand-in with what a browser shows of a drag (types, items' kind, the files on drop).
interface Drag {
  types: string[];
  items: { kind: string; type: string }[];
  files: File[];
  dropEffect: string;
}

function drag({ files = [], text }: { files?: File[]; text?: string } = {}): Drag {
  return {
    types: [...(files.length ? ["Files"] : []), ...(text === undefined ? [] : ["text/plain"])],
    items: [...files.map((file) => ({ kind: "file", type: file.type })), ...(text === undefined ? [] : [{ kind: "string", type: "text/plain" }])],
    files,
    dropEffect: "none",
  };
}

function fire(target: EventTarget, type: string, data: Drag): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: data });
  target.dispatchEvent(event);
  return event;
}

const png = (name = "photo.png") => new File(["png"], name, { type: "image/png" });

describe("useFileDrop", () => {
  let panel: HTMLElement;
  let history: HTMLElement;
  let box: HTMLElement;
  let outside: HTMLElement;

  beforeEach(() => {
    panel = document.createElement("main");
    history = panel.appendChild(document.createElement("div"));
    box = panel.appendChild(document.createElement("textarea"));
    outside = document.createElement("nav");
    document.body.append(outside, panel);
  });
  afterEach(() => document.body.replaceChildren());

  function setup(refusal: (count: number | null) => string | null = () => null) {
    const accept = vi.fn();
    const refuse = vi.fn();
    const scope = effectScope();
    const drop = scope.run(() => useFileDrop(ref(panel), { refusal, accept, refuse }))!;
    // As the template binds them: on the panel, reached by bubbling from its children.
    panel.addEventListener("dragenter", (event) => drop.onDragEnter(event as DragEvent));
    panel.addEventListener("dragover", (event) => drop.onDragOver(event as DragEvent));
    panel.addEventListener("dragleave", (event) => drop.onDragLeave(event as DragEvent));
    panel.addEventListener("drop", (event) => drop.onDrop(event as DragEvent));
    panel.addEventListener("dragend", () => drop.onDragEnd());
    return { drop, accept, refuse, scope };
  }

  it("keeps a drag with files over the children; only a dragleave of the node entered last ends it", () => {
    const { drop } = setup();
    const data = drag({ files: [png()] });
    expect(fire(history, "dragenter", data).defaultPrevented).toBe(true);
    expect(data.dropEffect).toBe("copy");
    expect(drop.over.value).toBe(true);
    // The browser enters the next node before it leaves the previous one.
    fire(box, "dragenter", data);
    fire(history, "dragleave", data);
    expect(drop.over.value).toBe(true);
    // A repeated dragenter and a dragleave of a node left earlier change nothing.
    fire(box, "dragenter", data);
    fire(history, "dragleave", data);
    expect(fire(box, "dragover", data).defaultPrevented).toBe(true);
    expect(drop.over.value).toBe(true);
    // Out of the panel: the node outside is entered (not the panel's), then the box is left.
    fire(outside, "dragenter", data);
    fire(box, "dragleave", data);
    expect(drop.over.value).toBe(false);
  });

  it("leaves text and links to the browser", () => {
    const { drop, accept, refuse } = setup();
    for (const data of [drag({ text: "Текст из письма" }), { ...drag({ text: "https://example.com" }), types: ["text/uri-list", "text/plain"] }]) {
      for (const type of ["dragenter", "dragover", "drop"]) expect(fire(box, type, data).defaultPrevented).toBe(false);
      expect(data.dropEffect).toBe("none");
      expect(drop.over.value).toBe(false);
    }
    expect(accept).not.toHaveBeenCalled();
    expect(refuse).not.toHaveBeenCalled();
  });

  it("accepts the dropped files and ends the drag; the browser opens nothing", () => {
    const { drop, accept, refuse } = setup();
    const file = png();
    const data = drag({ files: [file] });
    fire(history, "dragenter", data);
    expect(drop.count.value).toBe(1);
    expect(fire(history, "drop", data).defaultPrevented).toBe(true);
    expect(accept).toHaveBeenCalledWith([file]);
    expect(refuse).not.toHaveBeenCalled();
    expect(drop.over.value).toBe(false);
    expect(drop.count.value).toBeNull();
  });

  it("a refused drag gets the none drop effect and stays taken; a drop that comes anyway is said, not used", () => {
    const { drop, accept, refuse } = setup(() => "Идёт отправка.");
    const data = drag({ files: [png()] });
    expect(fire(box, "dragenter", data).defaultPrevented).toBe(true);
    expect(data.dropEffect).toBe("none");
    expect(drop.over.value).toBe(true);
    expect(fire(box, "drop", data).defaultPrevented).toBe(true);
    expect(refuse).toHaveBeenCalledWith("Идёт отправка.");
    expect(accept).not.toHaveBeenCalled();
    expect(drop.over.value).toBe(false);
  });

  it("tells the refusal how many files the drag carries, and the drop how many it brought", () => {
    const refusal = vi.fn((count: number | null) => (count !== null && count > 1 ? "Один файл." : null));
    const { drop, accept, refuse } = setup(refusal);
    const data = drag({ files: [png("a.png"), png("b.png")] });
    fire(history, "dragenter", data);
    expect(drop.count.value).toBe(2);
    expect(data.dropEffect).toBe("none");
    // A browser that tells nothing before the drop: the count is unknown, the drop has it.
    const hidden = { ...data, items: [] };
    fire(history, "dragover", hidden);
    expect(drop.count.value).toBeNull();
    expect(hidden.dropEffect).toBe("copy");
    fire(history, "drop", hidden);
    expect(refusal).toHaveBeenLastCalledWith(2);
    expect(refuse).toHaveBeenCalledWith("Один файл.");
    expect(accept).not.toHaveBeenCalled();
  });

  it("ends on a cancel (a dragleave of the node it is over) and on dragend", () => {
    const { drop } = setup();
    const data = drag({ files: [png()] });
    fire(history, "dragenter", data);
    fire(history, "dragleave", data);
    expect(drop.over.value).toBe(false);
    fire(history, "dragenter", data);
    fire(history, "dragend", data);
    expect(drop.over.value).toBe(false);
  });

  it("a dragover elsewhere in the page ends a drag whose node was removed under it", () => {
    const { drop } = setup();
    const data = drag({ files: [png()] });
    const message = history.appendChild(document.createElement("article"));
    fire(message, "dragenter", data);
    message.remove();
    // Its dragleave goes to the removed node and never reaches the panel.
    fire(message, "dragleave", data);
    expect(drop.over.value).toBe(true);
    fire(outside, "dragover", data);
    expect(drop.over.value).toBe(false);
  });

  it("interrupted, the highlight goes and a drop before the drag moves again is refused; a dragover takes it again", () => {
    const { drop, accept, refuse } = setup();
    const file = png();
    const data = drag({ files: [file] });
    drop.interrupt("Диалог сменился.");
    fire(history, "dragenter", data);
    drop.interrupt("Диалог сменился.");
    expect(drop.over.value).toBe(false);
    expect(fire(history, "drop", data).defaultPrevented).toBe(true);
    expect(refuse).toHaveBeenCalledWith("Диалог сменился.");
    expect(accept).not.toHaveBeenCalled();
    fire(history, "dragenter", data);
    drop.interrupt("Диалог сменился.");
    fire(history, "dragover", data);
    expect(drop.over.value).toBe(true);
    fire(history, "drop", data);
    expect(accept).toHaveBeenCalledWith([file]);
    expect(refuse).toHaveBeenCalledTimes(1);
  });

  it("ends with its scope (the component unmounted)", () => {
    const { drop, scope } = setup();
    fire(history, "dragenter", drag({ files: [png()] }));
    scope.stop();
    expect(drop.over.value).toBe(false);
  });
});
