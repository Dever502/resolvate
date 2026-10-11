import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "../../stores/session";
import { useThemeStore } from "../../stores/theme";
import AccountFooter from "./AccountFooter.vue";

enableAutoUnmount(afterEach);

describe("account menu", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    useSessionStore().signIn({ account: { id: "a", name: "Operator Name", login: "operator",
      role: "operator", active: true, telegram_id: null }, csrf: "csrf" });
  });

  it.each([['operator', 'Оператор'], ['admin', 'Администратор установки']] as const)(
    "shows one full-row trigger and the %s identity, with no settings placeholder", async (role, label) => {
      useSessionStore().account!.role = role;
      const wrapper = mount(AccountFooter);
      expect(wrapper.findAll("button")).toHaveLength(1);
      expect(wrapper.get("button").attributes("aria-label")).toBe(`Меню аккаунта: Operator Name, ${label}`);
      expect(wrapper.text()).not.toContain("Выйти");
      await wrapper.get("button").trigger("keydown", { key: "Enter" });
      await flushPromises();
      expect(document.querySelector(".account-identity")?.textContent).toContain(label);
      expect(document.querySelector(".account-menu")?.textContent).not.toContain("Настройки");
    },
  );

  it("selects a theme without dismissing the menu", async () => {
    const wrapper = mount(AccountFooter);
    await wrapper.get("button").trigger("keydown", { key: "Enter" });
    await flushPromises();
    const dark = document.querySelector<HTMLElement>('[aria-label="Тёмная тема"]')!;
    dark.click();
    await flushPromises();
    expect(useThemeStore().preference).toBe("dark");
    expect(localStorage.getItem("resolvate.theme")).toBe("dark");
    expect(dark.getAttribute("aria-checked")).toBe("true");
    expect(wrapper.get("button").attributes("aria-expanded")).toBe("true");
    expect(document.querySelectorAll('[role="menuitemradio"][aria-checked="true"]')).toHaveLength(1);
  });

  it("prevents duplicate logout requests and preserves the account on failure", async () => {
    let fail!: (error: Error) => void;
    const session = useSessionStore();
    const api = vi.spyOn(session, "logout").mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    const wrapper = mount(AccountFooter);
    await wrapper.get("button").trigger("keydown", { key: "Enter" });
    await flushPromises();
    const logout = document.querySelector<HTMLElement>(".account-logout")!;
    logout.click();
    logout.click();
    await flushPromises();
    expect(api).toHaveBeenCalledTimes(1);
    expect(logout.getAttribute("aria-disabled")).toBe("true");
    fail(new Error("Не удалось выйти."));
    await flushPromises();
    expect(session.status).toBe("signed-in");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Не удалось выйти.");
    expect(logout.hasAttribute("aria-disabled")).toBe(false);
  });
});
