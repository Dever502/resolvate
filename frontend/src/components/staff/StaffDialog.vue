<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { Account } from "../../api/types";
import { errorMessage, useRequest } from "../../composables/useRequest";
import { avatarTone } from "../../lib/format";
import { initials } from "../../lib/initials";
import { useProjectsStore } from "../../stores/projects";
import { useSessionStore } from "../../stores/session";
import { useStaffStore } from "../../stores/staff";
import { useWorkspaceStore } from "../../stores/workspace";
import ConfirmDialog from "../ui/ConfirmDialog.vue";
import Icon from "../ui/Icon.vue";
import ModalDialog from "../ui/ModalDialog.vue";
import StaffCreateForm from "./StaffCreateForm.vue";
import TelegramIdDialog from "./TelegramIdDialog.vue";

// "Сотрудники" (installation administrator): every console account with its role, state and links
// (Telegram ID, projects it administers), a new account, the Telegram ID, and switching an account
// off or on. Switching off is not deleting: the account and its history stay, its sessions end.
// The server keeps the rules (the last administrator, project administrators) and checks the rights.
const workspace = useWorkspaceStore();
const staff = useStaffStore();
const session = useSessionStore();
const projects = useProjectsStore();
const open = computed(() => workspace.admin?.window === "staff");
const request = useRequest();
const confirm = useRequest();
const loading = ref(false);
const loadError = ref("");
const query = ref("");
const disabling = ref<Account | null>(null);
const editing = ref<Account | null>(null);
const disablingOpen = computed({
  get: () => disabling.value !== null,
  set: (value) => { if (!value && !confirm.busy) disabling.value = null; },
});
const shown = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return staff.accounts.filter((account) => !needle || account.login.includes(needle)
    || account.name.toLowerCase().includes(needle) || String(account.telegram_id ?? "").includes(needle));
});

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    await staff.refresh();
  } catch (error) {
    loadError.value = errorMessage(error);
  } finally {
    loading.value = false;
  }
}

watch(open, (value) => {
  if (!value) return;
  query.value = "";
  request.clear();
  void load();
}, { immediate: true });

function setOpen(value: boolean): void {
  if (!value) workspace.closeAdmin();
}

function administered(account: Account): string {
  return projects.all.filter((project) => project.admin_id === account.id).map((project) => `«${project.name}»`).join(", ");
}

function describe(account: Account): string {
  return [
    account.login,
    account.role === "admin" ? "администратор установки" : "сотрудник",
    account.telegram_id ? `Telegram ID ${account.telegram_id}` : "Telegram ID не привязан",
  ].join(" · ");
}

function enable(account: Account): void {
  void request.run(async () => {
    await staff.setActive(account, true);
    return `Аккаунт ${account.login} включён.`;
  });
}

function askDisable(account: Account): void {
  if (request.busy) return;
  confirm.clear();
  disabling.value = account;
}

async function disable(): Promise<void> {
  const account = disabling.value;
  if (!account) return;
  const done = await confirm.run(() => staff.setActive(account, false));
  if (!done) return;
  disabling.value = null;
  request.clear();
  request.status = `Аккаунт ${account.login} отключён, сессии аккаунта завершены.`;
}

function saved(text: string): void {
  request.clear();
  request.status = text;
}
</script>

<template>
  <ModalDialog
    :open="open"
    title="Сотрудники"
    description="Аккаунты для входа в панель. Создание аккаунта не даёт доступа к проектам: доступ выдаётся в разделе «Проекты»."
    :locked="request.busy"
    wide
    @update:open="setOpen"
  >
    <p v-if="request.status" class="error" :class="{ success: !request.failed }" :role="request.failed ? 'alert' : 'status'">{{ request.status }}</p>
    <p v-if="loadError" class="error" role="alert">
      {{ loadError }}
      <button type="button" class="quiet ml-1" :aria-disabled="loading || undefined" @click="!loading && load()">Повторить</button>
    </p>
    <p v-else-if="!staff.loaded" class="muted">Загружаем сотрудников…</p>
    <template v-else>
      <div class="search-field mt-4">
        <Icon name="search" />
        <input v-model="query" type="search" maxlength="100" placeholder="Имя, логин или Telegram ID" aria-label="Найти сотрудника" />
      </div>
      <ul class="admin-list" aria-label="Сотрудники">
        <li v-for="account in shown" :key="account.id" class="admin-row">
          <span class="avatar" :class="avatarTone(account.id)" aria-hidden="true">{{ initials(account.name) }}</span>
          <div class="min-w-0 flex-1">
            <p class="admin-row-title">
              <span class="[overflow-wrap:anywhere]">{{ account.name }}</span>
              <span v-if="account.id === session.account?.id" class="pill">Вы</span>
              <span class="pill" :class="account.active ? 'pill-on' : 'pill-off'">{{ account.active ? "Активен" : "Отключён" }}</span>
            </p>
            <p class="muted small m-0 [overflow-wrap:anywhere]">{{ describe(account) }}</p>
            <p v-if="administered(account)" class="muted small m-0 [overflow-wrap:anywhere]">Администратор проектов: {{ administered(account) }}</p>
          </div>
          <div class="admin-actions">
            <button type="button" class="quiet" :aria-disabled="request.busy || undefined" :aria-label="`Telegram ID: ${account.name}`"
              @click="!request.busy && (editing = account)">Telegram ID</button>
            <button v-if="account.id !== session.account?.id" type="button" :class="account.active ? 'quiet' : 'secondary'"
              :aria-disabled="request.busy || undefined" :aria-label="`${account.active ? 'Отключить' : 'Включить'}: ${account.name}`"
              @click="!request.busy && (account.active ? askDisable(account) : enable(account))">
              {{ account.active ? "Отключить" : "Включить" }}
            </button>
          </div>
        </li>
      </ul>
      <p v-if="!shown.length" class="muted">{{ query.trim() ? "Никого не нашли." : "Аккаунтов пока нет." }}</p>
    </template>
    <details class="disclosure">
      <summary>Добавить сотрудника</summary>
      <StaffCreateForm />
    </details>
  </ModalDialog>
  <ConfirmDialog
    v-model:open="disablingOpen"
    :title="`Отключить аккаунт ${disabling?.login ?? ''}?`"
    :description="`${disabling?.name ?? ''} не сможет войти в панель, все сессии аккаунта завершатся. Аккаунт, доступы к проектам и история сохранятся; аккаунт можно включить снова.`"
    confirm-label="Отключить"
    busy-label="Отключаем…"
    :busy="confirm.busy"
    :error="confirm.failed ? confirm.status : ''"
    danger
    @confirm="disable"
  />
  <TelegramIdDialog v-model:account="editing" @saved="saved" />
</template>
