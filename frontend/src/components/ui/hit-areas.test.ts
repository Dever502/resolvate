import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { TooltipProvider } from "reka-ui";
import { h } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import ActionMenu from "./ActionMenu.vue";
import IconButton from "./IconButton.vue";
import ModalDialog from "./ModalDialog.vue";

enableAutoUnmount(afterEach);
const MINIMUM = ["min-h-11", "min-w-11"];

// The icon buttons of the primitives are hit areas of at least 44×44 px whatever the pointer. The boxes themselves
// are measured in the browsers (e2e/target-sizes.spec.ts); here only that each primitive asks for the minimum.
describe("hit areas of the primitives", () => {
  it("an icon button keeps the minimum next to the classes its user adds", () => {
    const wrapper = mount(TooltipProvider, {
      slots: { default: () => h(IconButton, { label: "Убрать вложение", class: "quiet attachment-preview-remove" }, () => "×") },
    });
    const button = wrapper.get("button");
    expect(button.classes()).toEqual(expect.arrayContaining([...MINIMUM, "quiet", "attachment-preview-remove"]));
    expect(button.attributes("aria-label")).toBe("Убрать вложение");
  });

  it("the button of an actions menu has the minimum", () => {
    const wrapper = mount(ActionMenu, { props: { label: "Действия с группой /общее", actions: [{ key: "rename", label: "Переименовать" }] } });
    expect(wrapper.get("button").classes()).toEqual(expect.arrayContaining(MINIMUM));
  });

  it("the close button of a window has the minimum", async () => {
    mount(ModalDialog, { props: { open: true, title: "Общие папки" }, attachTo: document.body });
    await flushPromises();
    const close = document.body.querySelector('[role="dialog"] button[aria-label="Закрыть"]');
    expect(close).not.toBeNull();
    expect([...close!.classList]).toEqual(expect.arrayContaining(MINIMUM));
  });
});
