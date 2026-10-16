import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import QuickReplies from "./QuickReplies.vue";

enableAutoUnmount(afterEach);
afterEach(() => vi.restoreAllMocks());

it("pointer selection does not fight wheel scrolling; keyboard selection still scrolls", async () => {
  const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
  const wrapper = mount(QuickReplies, {
    attachTo: document.body,
    props: {
      id: "picker", replies: [{ id: "a", text: "A" }, { id: "b", text: "B" }],
      active: 0, group: "", loading: false, failed: false, more: false, query: "",
    },
  });
  await wrapper.findAll('[role="option"]')[1]!.trigger("pointermove");
  expect(wrapper.emitted("hover")).toEqual([[1]]);
  await wrapper.setProps({ active: 1 });
  await flushPromises();
  expect(scroll).not.toHaveBeenCalled();

  // A later keyboard selection must not inherit the pointer suppression.
  await wrapper.setProps({ active: 0 });
  await flushPromises();
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
});
