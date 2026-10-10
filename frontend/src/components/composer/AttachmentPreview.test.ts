import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { TooltipProvider } from "reka-ui";
import { h, reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AttachmentPreview from "./AttachmentPreview.vue";

enableAutoUnmount(afterEach);
const file = (name = "photo.png", type = "image/png") => new File(["test"], name, { type });
const bitmap = (width = 1200, height = 800) => ({ width, height, close: vi.fn() });
const draw = vi.fn();
const decode = vi.fn();

function render(selected = file()) {
  const props = reactive({ file: selected, disabled: false });
  const wrapper = mount(TooltipProvider, { slots: { default: () => h(AttachmentPreview, props) } });
  return { props, wrapper, preview: wrapper.getComponent(AttachmentPreview) };
}

describe("attachment preview", () => {
  beforeEach(() => {
    draw.mockReset();
    decode.mockReset().mockImplementation(async () => bitmap());
    vi.stubGlobal("createImageBitmap", decode);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D);
    // Local files must never be turned into a CSP-blocked URL or sent to a server to preview.
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => { throw new Error("No blob URLs under CSP"); });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it.each([[1200, 800, 192, 128], [600, 1200, 64, 128], [24, 12, 24, 12]])(
    "draws %s×%s without stretching and immediately closes the bitmap", async (width, height, w, h) => {
      const image = bitmap(width, height);
      decode.mockResolvedValue(image);
      const { wrapper } = render();
      await flushPromises();
      const canvas = wrapper.get("canvas").element;
      expect([canvas.width, canvas.height]).toEqual([w, h]);
      expect(draw).toHaveBeenCalledWith(image, 0, 0, w, h);
      expect(image.close).toHaveBeenCalledExactlyOnceWith();
      expect(wrapper.text()).toContain("photo.png");
      expect(wrapper.text()).toContain("Изображение · 4 Б");
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      wrapper.unmount();
      expect([canvas.width, canvas.height]).toEqual([1, 1]);
    },
  );

  it("discards a late decode after replacement, then cleans up the backing store", async () => {
    let finish!: (value: ReturnType<typeof bitmap>) => void;
    decode.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { wrapper, props } = render();
    await flushPromises();
    props.file = file("new.webp", "image/webp");
    await flushPromises();
    const old = bitmap();
    finish(old);
    await flushPromises();
    expect(old.close).toHaveBeenCalledOnce();
    expect(draw).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain("new.webp");
    props.file = file("report.pdf", "application/pdf");
    await flushPromises();
    expect(wrapper.get("canvas").element.width).toBe(1);
    expect(wrapper.get("canvas").element.style.display).toBe("none");
  });

  it("closes a bitmap that finishes after unmount, without drawing", async () => {
    let finish!: (value: ReturnType<typeof bitmap>) => void;
    decode.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { wrapper } = render();
    await flushPromises();
    wrapper.unmount();
    const image = bitmap();
    finish(image);
    await flushPromises();
    expect(image.close).toHaveBeenCalledOnce();
    expect(draw).not.toHaveBeenCalled();
  });

  it("falls back on decode errors, and retries when the file changes", async () => {
    decode.mockRejectedValueOnce(new Error("Invalid image"));
    const { wrapper, props } = render();
    await flushPromises();
    expect(wrapper.text()).toContain("Предпросмотр недоступен");
    expect(wrapper.get("canvas").element.style.display).toBe("none");
    props.file = file("good.jpeg", "image/jpeg");
    await flushPromises();
    expect(wrapper.text()).not.toContain("Предпросмотр недоступен");
    expect(wrapper.get("canvas").element.style.display).not.toBe("none");
  });

  it("falls back when createImageBitmap is unavailable", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    const { wrapper } = render();
    await flushPromises();
    expect(wrapper.text()).toContain("Предпросмотр недоступен");
  });

  it("closes the bitmap if the canvas fails", async () => {
    const image = bitmap();
    decode.mockResolvedValue(image);
    draw.mockImplementationOnce(() => { throw new Error("Canvas unavailable"); });
    const { wrapper } = render();
    await flushPromises();
    expect(wrapper.text()).toContain("Предпросмотр недоступен");
    expect(image.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["clip.mp4", "video/mp4", "Видео"], ["clip.mov", "video/quicktime", "Видео"],
    ["report.pdf", "application/pdf", "PDF"], ["voice.ogg", "audio/ogg", "Аудио"],
    ["voice.opus", "audio/opus", "Аудио"], ["voice.opus", "", "Аудио"],
    ["drawing.svg", "image/svg+xml", "Формат не поддерживается"],
    ["archive.zip", "application/zip", "Формат не поддерживается"],
  ])("shows a safe metadata card for %s", async (name, type, label) => {
    const { wrapper } = render(file(name, type));
    await flushPromises();
    expect(wrapper.text()).toContain(name);
    expect(wrapper.text()).toContain(label);
    expect(decode).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(wrapper.find("img, video, audio, iframe, object").exists()).toBe(false);
  });

  it("preserves the full file name and disables removal during send", async () => {
    const name = `${"длинное имя ".repeat(40)}.png`;
    const { wrapper, props, preview } = render(file(name));
    await flushPromises();
    expect(wrapper.get(".attachment-preview-name").attributes("title")).toBe(name);
    props.disabled = true;
    await flushPromises();
    const remove = wrapper.get('[aria-label="Убрать вложение"]');
    expect(remove.attributes("disabled")).toBeDefined();
    await remove.trigger("click");
    expect(preview.emitted("remove")).toBeUndefined();
    props.disabled = false;
    await flushPromises();
    await remove.trigger("click");
    expect(preview.emitted("remove")).toHaveLength(1);
  });
});
