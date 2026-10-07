<script setup lang="ts">
import { computed, onMounted, ref, useTemplateRef } from "vue";
import { useSessionStore } from "../stores/session";
import Icon from "./ui/Icon.vue";

const session = useSessionStore();
const loginName = ref("");
const password = ref("");
const busy = ref(false);
const error = ref("");
const loginField = useTemplateRef<HTMLInputElement>("login-field");

const message = computed(() => error.value || session.notice);
const success = computed(() => !error.value && session.noticeIsSuccess);

// The form is shown only after the session check, so autofocus would be too late.
onMounted(() => loginField.value?.focus());

async function submit(): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    await session.login(loginName.value, password.value);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main id="login-screen" class="grid min-h-dvh place-items-center bg-canvas p-6">
    <form
      id="login-form"
      class="w-full max-w-[420px] rounded-[20px] bg-surface p-10 shadow-[0_12px_48px_#1d1d1f0a] narrow:px-6 narrow:py-8"
      @submit.prevent="submit"
    >
      <div class="brand mb-11">
        <span class="brand-mark" aria-hidden="true"><Icon name="resolve" /></span>
        Resolvate
      </div>
      <h1 class="mb-2.5">Вход в поддержку</h1>
      <p class="muted mb-8">Войдите в свой рабочий аккаунт.</p>
      <label>
        Логин
        <input
          ref="login-field"
          v-model="loginName"
          name="login"
          autocomplete="username"
          required
          maxlength="64"
        />
      </label>
      <label>
        Пароль
        <input
          v-model="password"
          name="password"
          type="password"
          autocomplete="current-password"
          required
          minlength="12"
          maxlength="128"
        />
      </label>
      <p id="login-error" class="error" :class="{ success }" role="alert">{{ message }}</p>
      <button class="primary mt-2 min-h-11 w-full" type="submit" :disabled="busy">Войти</button>
      <p class="hint">Доступ выдаёт администратор вашей поддержки.</p>
    </form>
  </main>
</template>
