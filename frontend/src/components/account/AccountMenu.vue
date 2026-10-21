<script setup lang="ts">
import {
  DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuPortal,
  DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger,
} from "reka-ui";
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef } from "vue";
import { initials } from "../../lib/initials";
import { clearNavigation } from "../../lib/navigation";
import { clearWork, countWork, patience } from "../../lib/workStore";
import { useChatStore } from "../../stores/chat";
import { useSessionStore } from "../../stores/session";
import { useWorkspaceStore } from "../../stores/workspace";
import ConfirmDialog from "../ui/ConfirmDialog.vue";
import Icon from "../ui/Icon.vue";
import PasswordDialog from "./PasswordDialog.vue";
import ThemeSelector from "./ThemeSelector.vue";

const session = useSessionStore();
const open = ref(false);
const busy = ref(false);
const error = ref("");
const name = computed(() => session.account?.name ?? "");
const role = computed(() => session.account?.role === "admin" ? "Администратор установки" : "Оператор");
const trigger = useTemplateRef<{ $el: HTMLElement }>("trigger");
const passwordOpen = ref(false);
let passwordRequested = false;
/** Unsent work this account keeps in the browser: an explicit sign-out asks before removing it. */
const kept = ref({ drafts: 0, attempts: 0 });
const leaveOpen = ref(false);
let leaveRequested = false;
/** Gone from the page (a phone's drawer closed while signing out): a late error goes to the workspace's notice. */
let gone = false;
onBeforeUnmount(() => { gone = true; });

function requestPassword(): void {
  passwordRequested = true;
}

// Reka returns focus to the trigger only after a timeout; a window opened earlier would remember the
// vanishing menu item and lose focus when it closes. The trigger takes focus first, then the window opens.
function afterClose(event: Event): void {
  if (!passwordRequested && !leaveRequested) return;
  const password = passwordRequested;
  passwordRequested = false;
  leaveRequested = false;
  event.preventDefault();
  trigger.value?.$el.focus();
  void nextTick(() => {
    if (password) passwordOpen.value = true;
    else leaveOpen.value = true;
  });
}

// An explicit sign-out leaves nothing of the account's unsent work on this device (the browser's storage
// and the tab's own); with work kept it asks first. A session that ends by itself (expired, password
// changed) keeps it for the next sign-in.
async function logout(): Promise<void> {
  if (busy.value) return;
  const account = session.account?.id;
  let work: { drafts: number; attempts: number } | null = null;
  busy.value = true;
  try {
    // Edits still waiting are written first: the count includes them. A storage that does not answer
    // is not waited for.
    await patience(useChatStore().flushDrafts()).catch(() => undefined);
    work = account ? await patience(countWork(account)).catch(() => null) : null;
  } finally {
    busy.value = false;
  }
  if (work && (work.drafts || work.attempts)) {
    kept.value = work;
    leaveRequested = true;
    open.value = false;
    return;
  }
  await leave();
}

async function leave(): Promise<void> {
  if (busy.value) return;
  const account = session.account?.id;
  busy.value = true;
  error.value = "";
  try {
    await session.logout();
    open.value = false;
    leaveOpen.value = false;
  } catch (caught) {
    if (gone) useWorkspaceStore().fail(caught);
    else error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = false;
  }
  // Signed out, by this request or by the server's 401 to it (the session had ended already): the
  // account's work leaves this device all the same. Writes queued as the session ended land first,
  // so nothing comes back after the removal.
  if (account && session.account?.id !== account) {
    clearNavigation();
    await useChatStore().flushDrafts();
    await clearWork(account).catch(() => undefined);
  }
}
</script>

<template>
  <DropdownMenuRoot v-model:open="open" :modal="false">
    <DropdownMenuTrigger ref="trigger" class="account-trigger" :aria-label="`Меню аккаунта: ${name}, ${role}`">
      <span class="avatar size-9 shrink-0 text-xs" aria-hidden="true">{{ initials(name) }}</span>
      <span class="min-w-0 flex-1 text-left">
        <strong class="block truncate text-[.8125rem] font-semibold" :title="name">{{ name }}</strong>
        <span class="muted mt-px block truncate text-xs">{{ role }}</span>
      </span>
      <Icon name="chevron" class="account-chevron size-4 shrink-0" />
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent class="menu account-menu" side="top" align="start" :side-offset="12" :collision-padding="8" loop
        @close-auto-focus="afterClose">
        <DropdownMenuLabel class="account-identity">
          <span class="avatar size-9 shrink-0 text-xs" aria-hidden="true">{{ initials(name) }}</span>
          <span class="min-w-0">
            <strong class="block truncate text-sm font-semibold" :title="name">{{ name }}</strong>
            <span class="muted mt-1 block text-xs">{{ role }}</span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator class="account-separator" />
        <!-- Personal settings. Installation/project administration remains in its separate
             navigation (the app bar's "Управление"). -->
        <DropdownMenuItem class="menu-item" @select="requestPassword">
          <Icon name="lock" class="size-4" />
          <span>Сменить пароль</span>
        </DropdownMenuItem>
        <ThemeSelector />
        <DropdownMenuSeparator class="account-separator" />
        <!-- Keep the menu while awaiting the API, including errors. Reka disables selection
             on this non-button item; the handler also guards against same-tick repeats. -->
        <DropdownMenuItem class="menu-item account-logout" :disabled="busy" @select.prevent="logout">
          <Icon name="logout" class="size-4" />
          {{ busy ? "Выходим…" : "Выйти" }}
        </DropdownMenuItem>
        <p v-if="error" class="error account-error" role="alert">{{ error }}</p>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
  <!-- A failed request stays visible even after dismissing the menu, including on phones. -->
  <p v-if="error && !open" class="error account-error" role="alert">{{ error }}</p>
  <PasswordDialog v-model:open="passwordOpen" />
  <ConfirmDialog
    v-model:open="leaveOpen"
    title="Выйти и удалить черновики?"
    :description="`В этом браузере сохранены черновики (${kept.drafts}) и отправки с неизвестным результатом (${kept.attempts}). После выхода они будут удалены с этого устройства.`"
    confirm-label="Выйти и удалить"
    busy-label="Выходим…"
    cancel-label="Остаться"
    :busy="busy"
    :error="error"
    danger
    @confirm="leave"
  />
</template>
