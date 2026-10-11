<script setup lang="ts">
import { computed, nextTick, ref, useId, useTemplateRef, watch } from "vue";
import type { Account } from "../../api/types";
import { useRequest } from "../../composables/useRequest";
import { telegramId, telegramIdProblem } from "../../lib/accounts";
import { useStaffStore } from "../../stores/staff";
import ModalDialog from "../ui/ModalDialog.vue";

// The Telegram ID of an account (POST /console/accounts/{id}/identity/telegram): with it, and with
// access to a project, the employee answers customers from the project's support group. A Telegram
// ID belongs to one account; a taken one is refused and the typed value stays.
const account = defineModel<Account | null>("account", { required: true });
const emit = defineEmits<{ saved: [text: string] }>();
const staff = useStaffStore();
const request = useRequest();
const id = useId();
const field = useTemplateRef<HTMLInputElement>("field");
const value = ref("");
const problem = ref("");
const open = computed({
  get: () => account.value !== null,
  set: (shown) => { if (!shown && !request.busy) account.value = null; },
});

watch(account, (current) => {
  value.value = current?.telegram_id ? String(current.telegram_id) : "";
  problem.value = "";
  request.clear();
});

async function save(unlink = false): Promise<void> {
  const current = account.value;
  if (!current || request.busy) return;
  const text = unlink ? "" : value.value;
  problem.value = telegramIdProblem(text);
  if (problem.value) {
    await nextTick();
    field.value?.focus();
    return;
  }
  const next = telegramId(text);
  const done = await request.run(() => staff.setTelegramId(current, next));
  if (!done) return;
  account.value = null;
  emit("saved", next === null ? `Telegram ID отвязан: ${current.name}.` : `Telegram ID сохранён: ${current.name}.`);
}
</script>

<template>
  <ModalDialog
    v-model:open="open"
    :title="`Telegram ID: ${account?.name ?? ''}`"
    description="С Telegram ID и доступом к проекту сотрудник отвечает клиентам из группы поддержки. Один Telegram ID — у одного аккаунта."
    :locked="request.busy"
    @open-auto-focus="(event: Event) => { event.preventDefault(); field?.focus(); }"
  >
    <form class="mt-2" novalidate @submit.prevent="save()">
      <label :for="id" class="field-label">Telegram ID</label>
      <input
        :id="id"
        ref="field"
        v-model="value"
        class="field-input"
        inputmode="numeric"
        autocomplete="off"
        maxlength="16"
        :aria-invalid="problem ? 'true' : undefined"
        :aria-describedby="problem ? `${id}-error` : undefined"
        @input="problem = ''"
      />
      <p v-if="problem" :id="`${id}-error`" class="field-error">{{ problem }}</p>
      <p v-if="request.failed" class="error" role="alert">{{ request.status }}</p>
      <div class="mt-4 flex flex-wrap justify-end gap-2">
        <button v-if="account?.telegram_id" type="button" class="quiet" :aria-disabled="request.busy || undefined" @click="save(true)">Отвязать</button>
        <button type="submit" class="primary" :aria-disabled="request.busy || undefined">{{ request.busy ? "Сохраняем…" : "Сохранить" }}</button>
      </div>
    </form>
  </ModalDialog>
</template>
