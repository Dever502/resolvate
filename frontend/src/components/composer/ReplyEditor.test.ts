import { enableAutoUnmount, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import ReplyEditor from "./ReplyEditor.vue";

enableAutoUnmount(afterEach);

function render(props: Record<string, unknown> = {}) {
  return mount(ReplyEditor, {
    props: { mode: "create", group: "общее", dirty: false, "onUpdate:dirty": () => undefined, ...props },
    attachTo: document.body,
  });
}

describe("reply editor", () => {
  it("counts UTF-16 units like the server: an emoji takes two", async () => {
    const wrapper = render();
    // 1950 emoji are 3900 units: the limit itself is allowed.
    await wrapper.get("textarea").setValue("🙂".repeat(1950));
    expect(wrapper.text()).toContain("3900 / 3900 символов");
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("save")).toEqual([["🙂".repeat(1950)]]);
    await wrapper.get("textarea").setValue(`${"🙂".repeat(1950)}!`);
    await wrapper.get("form").trigger("submit");
    expect(wrapper.text()).toContain("Не больше 3900 символов.");
    expect(wrapper.emitted("save")).toHaveLength(1);
    expect(wrapper.get("textarea").attributes("aria-invalid")).toBe("true");
  });

  it("refuses empty and blank text without asking the server", async () => {
    const wrapper = render();
    for (const value of ["", " \n\t "]) {
      await wrapper.get("textarea").setValue(value);
      await wrapper.get("form").trigger("submit");
      expect(wrapper.text()).toContain("Введите текст ответа.");
    }
    expect(wrapper.emitted("save")).toBeUndefined();
  });

  it("Enter in the field never submits; a busy editor ignores another save", async () => {
    const wrapper = render({ busy: true, initial: "Текст" });
    await wrapper.get("textarea").trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("save")).toBeUndefined();
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("save")).toBeUndefined();
    expect(wrapper.get('button[type="submit"]').text()).toBe("Сохраняем…");
    expect(wrapper.get('button[type="submit"]').attributes("aria-disabled")).toBe("true");
  });

  it("reports unsaved changes and offers another operator's version without losing the draft", async () => {
    const changes: boolean[] = [];
    const wrapper = render({ mode: "edit", initial: "Старый текст", "onUpdate:dirty": (value: boolean) => changes.push(value) });
    expect(wrapper.get("textarea").element.value).toBe("Старый текст");
    await wrapper.get("textarea").setValue("Мой черновик");
    expect(changes.at(-1)).toBe(true);
    await wrapper.get("textarea").setValue("Старый текст");
    expect(changes.at(-1)).toBe(false);

    await wrapper.get("textarea").setValue("Мой черновик");
    await wrapper.setProps({ current: "Версия коллеги" });
    expect(wrapper.get('[role="group"][aria-label="Версия другого оператора"]').text()).toContain("Версия коллеги");
    expect(wrapper.get("textarea").element.value).toBe("Мой черновик");
    await wrapper.get('[role="group"] button').trigger("click");
    expect(wrapper.get("textarea").element.value).toBe("Версия коллеги");
  });

  it("locks the submitted text while saving and unlocks the retained draft after a refusal", async () => {
    const wrapper = render();
    const field = wrapper.get("textarea");
    await field.setValue("Сохраняемый черновик");
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("save")).toEqual([["Сохраняемый черновик"]]);
    await wrapper.setProps({ busy: true });
    expect(field.element.readOnly).toBe(true);
    expect(field.element.disabled).toBe(false);
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("save")).toHaveLength(1);
    await wrapper.setProps({ busy: false, error: "Нет связи с сервером." });
    expect(field.element.readOnly).toBe(false);
    expect(field.element.value).toBe("Сохраняемый черновик");
    await field.setValue("Исправленный черновик");
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("save")?.at(-1)).toEqual(["Исправленный черновик"]);
  });
});
