<script setup lang="ts">
import { nextTick, reactive, ref, useId, useTemplateRef } from "vue";
import { useRequest } from "../../composables/useRequest";
import { loginProblem, nameProblem, passwordProblem, telegramId, telegramIdProblem } from "../../lib/accounts";
import { useStaffStore } from "../../stores/staff";

// A new operator account. The installation has one administrator, so new accounts are always
// operators; project access is granted separately. A refused attempt (a taken login or Telegram ID)
// keeps everything typed; the passwords live only in this form and are cleared once it succeeds.
const staff = useStaffStore();
const request = useRequest();
const id = useId();
const form = useTemplateRef<HTMLFormElement>("form");
const fields = reactive({ name: "", login: "", password: "", confirmation: "", telegram: "" });
const errors = ref<Partial<Record<keyof typeof fields, string>>>({});

function check(): Partial<Record<keyof typeof fields, string>> {
  const found: Partial<Record<keyof typeof fields, string>> = {};
  if (nameProblem(fields.name)) found.name = nameProblem(fields.name);
  if (loginProblem(fields.login)) found.login = loginProblem(fields.login);
  if (passwordProblem(fields.password)) found.password = passwordProblem(fields.password);
  else if (fields.confirmation !== fields.password) found.confirmation = "Пароли не совпадают.";
  if (telegramIdProblem(fields.telegram)) found.telegram = telegramIdProblem(fields.telegram);
  return found;
}

async function submit(): Promise<void> {
  if (request.busy) return;
  errors.value = check();
  const first = (Object.keys(fields) as (keyof typeof fields)[]).find((key) => errors.value[key]);
  if (first) {
    request.clear();
    await nextTick();
    form.value?.querySelector<HTMLInputElement>(`[name="${first}"]`)?.focus();
    return;
  }
  const done = await request.run(async () => {
    const created = await staff.create({
      name: fields.name.trim(),
      login: fields.login.trim(),
      password: fields.password,
      telegram_id: telegramId(fields.telegram),
    });
    return `Сотрудник «${created.name}» создан. Доступ к проектам выдаётся в разделе «Проекты».`;
  });
  if (done) Object.assign(fields, { name: "", login: "", password: "", confirmation: "", telegram: "" });
}

function edited(key: keyof typeof fields): void {
  if (errors.value[key]) errors.value = { ...errors.value, [key]: "" };
}

const inputs: { key: keyof typeof fields; label: string; type: string; autocomplete: string; maxlength: number; inputmode?: "numeric" }[] = [
  { key: "name", label: "Имя", type: "text", autocomplete: "off", maxlength: 100 },
  { key: "login", label: "Логин", type: "text", autocomplete: "off", maxlength: 64 },
  { key: "password", label: "Пароль", type: "password", autocomplete: "new-password", maxlength: 128 },
  { key: "confirmation", label: "Повторите пароль", type: "password", autocomplete: "new-password", maxlength: 128 },
  { key: "telegram", label: "Telegram ID · необязательно", type: "text", autocomplete: "off", maxlength: 16, inputmode: "numeric" },
];
const hints: Partial<Record<keyof typeof fields, string>> = {
  login: "3–64 символа: латиница, цифры, точка, _ или -.",
  password: "От 12 до 128 символов. Передайте пароль сотруднику лично.",
  telegram: "Нужен, чтобы сотрудник отвечал клиентам из Telegram-группы.",
};
</script>

<template>
  <form ref="form" class="pt-2" novalidate @submit.prevent="submit">
    <div class="form-grid">
      <div v-for="input in inputs" :key="input.key">
        <label :for="`${id}-${input.key}`" class="field-label">{{ input.label }}</label>
        <input
          :id="`${id}-${input.key}`"
          v-model="fields[input.key]"
          class="field-input"
          :name="input.key"
          :type="input.type"
          :autocomplete="input.autocomplete"
          :maxlength="input.maxlength"
          :inputmode="input.inputmode"
          spellcheck="false"
          :aria-invalid="errors[input.key] ? 'true' : undefined"
          :aria-describedby="[hints[input.key] ? `${id}-${input.key}-hint` : '', errors[input.key] ? `${id}-${input.key}-error` : ''].filter(Boolean).join(' ') || undefined"
          @input="edited(input.key)"
        />
        <p v-if="hints[input.key]" :id="`${id}-${input.key}-hint`" class="muted small mt-1.5 mb-0">{{ hints[input.key] }}</p>
        <p v-if="errors[input.key]" :id="`${id}-${input.key}-error`" class="field-error">{{ errors[input.key] }}</p>
      </div>
    </div>
    <p v-if="request.status" class="error" :class="{ success: !request.failed }" :role="request.failed ? 'alert' : 'status'">{{ request.status }}</p>
    <div class="mt-3 flex justify-end">
      <button type="submit" class="primary" :aria-disabled="request.busy || undefined">{{ request.busy ? "Создаём…" : "Создать аккаунт" }}</button>
    </div>
  </form>
</template>
