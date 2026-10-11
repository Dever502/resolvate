<script setup lang="ts">
import { computed, ref } from "vue";
import { useRequest } from "../../composables/useRequest";
import { useSessionStore } from "../../stores/session";
import { useStaffStore } from "../../stores/staff";
import ConfirmDialog from "../ui/ConfirmDialog.vue";
import StaffPicker, { type StaffOption } from "./StaffPicker.vue";

// Handing the installation to another active account (POST /console/installation/admin). The
// installation has one administrator: the server makes this account an operator, the chosen one
// the administrator, and ends both accounts' sessions. Project roles and access stay as they are.
const session = useSessionStore();
const staff = useStaffStore();
const request = useRequest();
const successor = ref<StaffOption | null>(null);
const problem = ref("");
const confirming = ref(false);
const confirmingOpen = computed({
  get: () => confirming.value,
  set: (value) => { if (!value && !request.busy) confirming.value = false; },
});
const self = computed(() => session.account);
const chosen = computed(() => staff.accounts.find((account) => account.login === successor.value?.value) ?? null);

async function candidates(query: string): Promise<StaffOption[]> {
  if (!staff.loaded) await staff.refresh();
  const needle = query.toLowerCase();
  return staff.accounts
    .filter((account) => account.active && account.id !== self.value?.id)
    .filter((account) => !needle || account.login.includes(needle) || account.name.toLowerCase().includes(needle))
    .slice(0, 50)
    .map((account) => ({ value: account.login, label: account.name, detail: account.login }));
}

function ask(): void {
  if (request.busy) return;
  problem.value = chosen.value ? "" : "Выберите нового администратора установки из списка.";
  if (!chosen.value) return;
  request.clear();
  confirming.value = true;
}

async function transfer(): Promise<void> {
  const account = chosen.value;
  if (!account) return;
  // On success the session ends and the sign-in form says to whom the installation went.
  await request.run(() => staff.transferInstallation(account));
}
</script>

<template>
  <form novalidate @submit.prevent="ask">
    <p class="muted small mt-0">
      Сейчас администратор установки — вы ({{ self?.name }} · {{ self?.login }}). Эта роль одна на установку:
      управление сотрудниками, создание и включение проектов, назначение их администраторов.
    </p>
    <StaffPicker
      v-model="successor"
      label="Новый администратор установки"
      :search="candidates"
      chosen-hint="Нажмите «Передать управление» и подтвердите передачу."
      :error="problem"
      @update:model-value="problem = ''"
    />
    <p class="muted small">
      После передачи вы станете сотрудником без прав администратора установки. Ваши роли администратора проектов
      и доступы к проектам сохранятся. Сессии — ваша и нового администратора — завершатся.
    </p>
    <div class="flex justify-end">
      <button type="submit" class="danger" :aria-disabled="request.busy || undefined">Передать управление</button>
    </div>
  </form>
  <ConfirmDialog
    v-model:open="confirmingOpen"
    title="Передать управление установкой?"
    :description="`Новый администратор установки: ${chosen?.name ?? ''} · ${chosen?.login ?? ''}. Вы станете сотрудником, ваша сессия завершится, и панель вернётся к форме входа.`"
    confirm-label="Передать управление"
    busy-label="Передаём…"
    :busy="request.busy"
    :error="request.failed ? request.status : ''"
    danger
    @confirm="transfer"
  />
</template>
