import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "../../stores/session";
import LoginScreen from "./LoginScreen.vue";

enableAutoUnmount(afterEach);

describe("login attempt feedback", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.restoreAllMocks());

  it("locks credentials while checking, ignores duplicate submits and allows the first corrected retry", async () => {
    let reject!: (error: Error) => void;
    const login = vi.spyOn(useSessionStore(), "login")
      .mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }))
      .mockResolvedValueOnce(undefined);
    const wrapper = mount(LoginScreen);
    const username = wrapper.get('input[name="login"]');
    const password = wrapper.get('input[name="password"]');
    const form = wrapper.get("form");
    const button = wrapper.get("button");

    await username.setValue("operator");
    await password.setValue("wrong password!");
    await form.trigger("submit");
    expect(username.attributes()).toHaveProperty("readonly");
    expect(password.attributes()).toHaveProperty("readonly");
    expect(form.attributes("aria-busy")).toBe("true");
    expect(button.attributes("aria-disabled")).toBe("true");
    expect(button.text()).toBe("Проверяем…");
    await form.trigger("submit");
    expect(login).toHaveBeenCalledTimes(1);

    reject(new Error("Неверный логин или пароль."));
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe("Неверный логин или пароль.");
    expect(username.attributes()).not.toHaveProperty("readonly");
    expect(password.attributes()).not.toHaveProperty("readonly");
    expect(form.attributes("aria-busy")).toBeUndefined();
    expect(button.attributes("aria-disabled")).toBeUndefined();
    expect(button.text()).toBe("Войти");

    await password.setValue("correct password!");
    expect(wrapper.get('[role="alert"]').text()).toBe("");
    await form.trigger("submit");
    await flushPromises();
    expect(login).toHaveBeenCalledTimes(2);
    expect(login).toHaveBeenLastCalledWith("operator", "correct password!");
    expect(wrapper.get('[role="alert"]').text()).toBe("");
  });

  it("unlocks after a network failure and clears its error when the login is edited", async () => {
    vi.spyOn(useSessionStore(), "login").mockRejectedValue(new Error("Нет связи с сервером."));
    const wrapper = mount(LoginScreen);
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe("Нет связи с сервером.");
    expect(wrapper.get('input[name="login"]').attributes()).not.toHaveProperty("readonly");
    expect(wrapper.get('input[name="password"]').attributes()).not.toHaveProperty("readonly");
    await wrapper.get('input[name="login"]').setValue("corrected-user");
    expect(wrapper.get('[role="alert"]').text()).toBe("");
  });
});
