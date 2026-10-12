import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import MenuSelect from "./MenuSelect.vue";

enableAutoUnmount(afterEach);

// The layout and the turn of the chevron are checked in the browsers (e2e/project-picker.spec.ts); here only
// the classes each tone gets and the state Reka puts on the button.
describe("menu select", () => {
  it("in the app bar lets the chevron follow the value and turns it on Reka's own open state", async () => {
    const options = [{ value: "p1", label: "TEST_1" }, { value: "p2", label: "Второй проект" }];
    const wrapper = mount(MenuSelect, { props: { modelValue: "p1", options, label: "Текущий проект", tone: "chrome" } });
    const trigger = wrapper.get("button");
    expect(trigger.classes()).toContain("menu-select-chrome");
    expect(trigger.get("span").classes()).not.toContain("flex-1");
    expect(trigger.get("svg").classes()).toContain("menu-select-chevron");
    expect(trigger.attributes("data-state")).toBe("closed");
    await trigger.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(trigger.attributes("data-state")).toBe("open");
  });

  it("as a field keeps the value stretched and the chevron still", () => {
    const options = [{ value: "none", label: "Без папки" }];
    const wrapper = mount(MenuSelect, { props: { modelValue: "none", options, label: "Папка диалога" } });
    const trigger = wrapper.get("button");
    expect(trigger.classes()).not.toContain("menu-select-chrome");
    expect(trigger.get("span").classes()).toContain("flex-1");
    expect(trigger.get("svg").classes()).not.toContain("menu-select-chevron");
  });
});
