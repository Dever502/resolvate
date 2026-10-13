import { enableAutoUnmount, mount } from "@vue/test-utils";
import { afterEach, expect, it } from "vitest";
import type { SendAttempt } from "../../stores/chat";
import SendAttemptNotice from "./SendAttemptNotice.vue";

enableAutoUnmount(afterEach);

it("replaces an unknown-result alert on every retry without reusing the sending branch", async () => {
  const attempt: SendAttempt = {
    key: "attempt", project: "p1", ticket: "t1", text: "Reply", file: null,
    state: "unknown", reason: "Offline", tries: 1, createdAt: Date.now(), persisted: true,
  };
  const wrapper = mount(SendAttemptNotice, { props: { attempt, sending: false } });
  let alert = wrapper.get('[role="alert"]').element;
  // File comparison locks the Composer before the request begins.
  await wrapper.setProps({ sending: true });
  expect(wrapper.get('[role="alert"]').element).toBe(alert);
  for (const tries of [2, 3]) {
    await wrapper.setProps({ attempt: { ...attempt, tries, state: "sending" }, sending: true });
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("Повторяем отправку…");
    await wrapper.setProps({ attempt: { ...attempt, tries }, sending: false });
    const next = wrapper.get('[role="alert"]').element;
    expect(next).not.toBe(alert);
    expect(next.textContent).toContain("Offline");
    alert = next;
  }
});
