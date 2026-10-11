<script setup lang="ts">
import { computed, nextTick, reactive, ref, useId, useTemplateRef, watch } from "vue";
import { ApiError } from "../../api/client";
import type { Account } from "../../api/types";
import { useRequest } from "../../composables/useRequest";
import { passwordProblem } from "../../lib/accounts";
import { useSessionStore } from "../../stores/session";
import { useStaffStore } from "../../stores/staff";
import ConfirmDialog from "../ui/ConfirmDialog.vue";
import ModalDialog from "../ui/ModalDialog.vue";

// The own password change, or the installation administrator's reset of an employee's password
// (`target`). The server takes the new password only with the signed-in account's current one;
// a reset asks once more, by name. The passwords live in this window only: they are cleared when
// it closes and never reach a message, a log or the URL. A changed own password ends every session
// of the account on the server, so the console returns to the sign-in form (session store).
const open = defineModel<boolean>("open", { required: true });
const props = withDefaults(defineProps<{ target?: Account | null }>(), { target: null });
const emit = defineEmits<{ done: [text: string] }>();
const session = useSessionStore();
const staff = useStaffStore();
const request = useRequest();
const id = useId();
const form = useTemplateRef<HTMLFormElement>("form");
type Field = "current" | "next" | "confirmation";
const fields = reactive<Record<Field, string>>({ current: "", next: "", confirmation: "" });
const errors = ref<Partial<Record<Field, string>>>({});
const confirming = ref(false);
// A reset refused for the current password returns focus to that field once the confirmation closes.
let fieldAfterConfirm = false;
const title = computed(() => (props.target ? `Сброс пароля: ${props.target.login}` : "Сменить пароль"));
const description = computed(() => (props.target
  ? `Новый пароль для аккаунта ${props.target.name}. Все сессии этого аккаунта завершатся, права и доступы не изменятся. Передайте пароль сотруднику лично.`
  : "После смены пароля все сессии вашего аккаунта завершатся, включая эту: войдите с новым паролем."));
const confirmingOpen = computed({
  get: () => confirming.value,
  set: (value) => { if (!value && !request.busy) confirming.value = false; },
});
const inputs: { key: Field; autocomplete: string }[] = [
  { key: "current", autocomplete: "current-password" },
  { key: "next", autocomplete: "new-password" },
  { key: "confirmation", autocomplete: "new-password" },
];
const labels = computed<Record<Field, string>>(() => ({
  current: "Текущий пароль вашего аккаунта",
  next: props.target ? "Новый пароль сотрудника" : "Новый пароль",
  confirmation: "Повторите новый пароль",
}));

function clear(): void {
  Object.assign(fields, { current: "", next: "", confirmation: "" });
  errors.value = {};
  confirming.value = false;
  request.clear();
}
watch(open, (value) => { if (!value) clear(); });

function check(): Partial<Record<Field, string>> {
  const found: Partial<Record<Field, string>> = {};
  if (!fields.current) found.current = "Введите текущий пароль.";
  if (passwordProblem(fields.next)) found.next = passwordProblem(fields.next);
  else if (fields.confirmation !== fields.next) found.confirmation = "Новые пароли не совпадают.";
  return found;
}

async function focus(key: Field): Promise<void> {
  await nextTick();
  const input = form.value?.querySelector<HTMLInputElement>(`[name="${key}"]`);
  input?.focus();
  input?.select();
}

async function submit(): Promise<void> {
  if (request.busy) return;
  errors.value = check();
  const first = inputs.find((input) => errors.value[input.key]);
  if (first) {
    request.clear();
    await focus(first.key);
    return;
  }
  if (props.target) confirming.value = true;
  else await send();
}

async function send(): Promise<void> {
  const target = props.target;
  const { current, next } = fields;
  let wrongPassword = false;
  const done = await request.run(async () => {
    try {
      if (target) await staff.resetPassword(target, current, next);
      else await session.changePassword(current, next);
    } catch (error) {
      wrongPassword = error instanceof ApiError && error.status === 403 && error.message.startsWith("Неверный текущий пароль");
      throw error;
    }
  });
  confirming.value = false;
  if (!done) {
    if (wrongPassword) {
      errors.value = { current: request.status };
      request.clear();
      if (target) fieldAfterConfirm = true;
      else await focus("current");
    }
    return;
  }
  if (!target || !open.value) return;
  open.value = false;
  emit("done", `Пароль аккаунта ${target.login} изменён, сессии аккаунта завершены. Передайте новый пароль сотруднику лично.`);
}

function afterConfirm(event: Event): void {
  if (!fieldAfterConfirm) return;
  fieldAfterConfirm = false;
  event.preventDefault();
  void focus("current");
}

// The window opens at its first field, not at its close button.
function startAtField(event: Event): void {
  event.preventDefault();
  void focus("current");
}

function edited(key: Field): void {
  if (errors.value[key]) errors.value = { ...errors.value, [key]: "" };
}
</script>

<template>
  <ModalDialog v-model:open="open" :title="title" :description="description" :locked="request.busy" @open-auto-focus="startAtField">
    <form ref="form" class="mt-2" novalidate :aria-busy="request.busy || undefined" @submit.prevent="submit">
      <div v-for="input in inputs" :key="input.key" class="mt-3">
        <label :for="`${id}-${input.key}`" class="field-label">{{ labels[input.key] }}</label>
        <input
          :id="`${id}-${input.key}`"
          v-model="fields[input.key]"
          class="field-input"
          :name="input.key"
          type="password"
          :autocomplete="input.autocomplete"
          maxlength="128"
          :aria-invalid="errors[input.key] ? 'true' : undefined"
          :aria-describedby="[input.key === 'next' ? `${id}-rule` : '', errors[input.key] ? `${id}-${input.key}-error` : ''].filter(Boolean).join(' ') || undefined"
          @input="edited(input.key)"
        />
        <p v-if="input.key === 'next'" :id="`${id}-rule`" class="muted small mt-1.5 mb-0">От 12 до 128 символов.</p>
        <p v-if="errors[input.key]" :id="`${id}-${input.key}-error`" class="field-error">{{ errors[input.key] }}</p>
      </div>
      <p v-if="request.failed && !confirming" class="error" role="alert">{{ request.status }}</p>
      <div class="mt-5 flex justify-end">
        <button type="submit" class="primary" :aria-disabled="request.busy || undefined">
          {{ request.busy ? "Сохраняем…" : target ? "Сбросить пароль" : "Сменить пароль" }}
        </button>
      </div>
    </form>
  </ModalDialog>
  <ConfirmDialog
    v-if="target"
    v-model:open="confirmingOpen"
    :title="`Сбросить пароль аккаунта ${target.login}?`"
    :description="`${target.name} сможет войти только с новым паролем; все текущие сессии этого аккаунта завершатся.`"
    confirm-label="Сбросить пароль"
    busy-label="Сбрасываем…"
    :busy="request.busy"
    danger
    @confirm="send"
    @close-auto-focus="afterConfirm"
  />
</template>
