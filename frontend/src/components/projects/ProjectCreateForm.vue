<script setup lang="ts">
import { ref, useId, useTemplateRef } from "vue";
import { useRequest } from "../../composables/useRequest";
import { useProjectsStore } from "../../stores/projects";
import { useSessionStore } from "../../stores/session";
import { useStaffStore } from "../../stores/staff";
import StaffPicker, { type StaffOption } from "../staff/StaffPicker.vue";

// A new project (installation administrator): its name and its administrator, chosen from the
// active accounts. The server creates it switched off; the administrator then sets up its bot and
// support group. Typed values stay when the server refuses them.
const session = useSessionStore();
const projects = useProjectsStore();
const staff = useStaffStore();
const request = useRequest();
const id = useId();
const nameField = useTemplateRef<HTMLInputElement>("name-field");
const self = (): StaffOption | null =>
  session.account ? { value: session.account.login, label: session.account.name, detail: session.account.login } : null;
const name = ref("");
const admin = ref<StaffOption | null>(self());
const pickerKey = ref(0);
const nameError = ref("");
const adminError = ref("");

async function accounts(query: string): Promise<StaffOption[]> {
  if (!staff.loaded) await staff.refresh();
  const needle = query.toLowerCase();
  return staff.accounts
    .filter((account) => account.active && (!needle || account.login.includes(needle) || account.name.toLowerCase().includes(needle)))
    .slice(0, 50)
    .map((account) => ({ value: account.login, label: account.name, detail: account.login }));
}

async function submit(): Promise<void> {
  if (request.busy) return;
  const title = name.value.trim();
  nameError.value = title ? "" : "Укажите название проекта.";
  adminError.value = admin.value ? "" : "Выберите администратора проекта из списка.";
  if (nameError.value) {
    nameField.value?.focus();
    return;
  }
  const chosen = admin.value;
  if (!chosen) return;
  const done = await request.run(async () => {
    await projects.create(title, chosen.value);
    return `Проект «${title}» создан выключенным. Администратор проекта настраивает бота и группу поддержки, затем проект можно включить.`;
  });
  if (!done) return;
  name.value = "";
  admin.value = self();
  pickerKey.value++;
}
</script>

<template>
  <form class="grid gap-1 pt-2" novalidate @submit.prevent="submit">
    <div>
      <label :for="`${id}-name`" class="field-label">Название</label>
      <input
        :id="`${id}-name`"
        ref="name-field"
        v-model="name"
        class="field-input"
        maxlength="100"
        autocomplete="off"
        :aria-invalid="nameError ? 'true' : undefined"
        :aria-describedby="nameError ? `${id}-name-error` : undefined"
        @input="nameError = ''"
      />
      <p v-if="nameError" :id="`${id}-name-error`" class="field-error">{{ nameError }}</p>
    </div>
    <div class="mt-3">
      <StaffPicker
        :key="pickerKey"
        v-model="admin"
        label="Администратор проекта"
        :search="accounts"
        chosen-hint="Администратор проекта настраивает бота, группу поддержки и участников."
        :error="adminError"
        @update:model-value="adminError = ''"
      />
    </div>
    <p v-if="request.status" class="error" :class="{ success: !request.failed }" :role="request.failed ? 'alert' : 'status'">{{ request.status }}</p>
    <div class="mt-3 flex justify-end">
      <button type="submit" class="primary" :aria-disabled="request.busy || undefined">{{ request.busy ? "Создаём…" : "Создать проект" }}</button>
    </div>
  </form>
</template>
