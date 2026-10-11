<script setup lang="ts">
import {
  DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuPortal,
  DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger,
} from "reka-ui";
import { computed, ref } from "vue";
import { initials } from "../../lib/initials";
import { useSessionStore } from "../../stores/session";
import Icon from "../ui/Icon.vue";
import ThemeSelector from "./ThemeSelector.vue";

const session = useSessionStore();
const open = ref(false);
const busy = ref(false);
const error = ref("");
const name = computed(() => session.account?.name ?? "");
const role = computed(() => session.account?.role === "admin" ? "Администратор установки" : "Оператор");

async function logout(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await session.logout();
    open.value = false;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <DropdownMenuRoot v-model:open="open" :modal="false">
    <DropdownMenuTrigger class="account-trigger" :aria-label="`Меню аккаунта: ${name}, ${role}`">
      <span class="avatar size-9 shrink-0 text-xs" aria-hidden="true">{{ initials(name) }}</span>
      <span class="min-w-0 flex-1 text-left">
        <strong class="block truncate text-[.8125rem] font-semibold" :title="name">{{ name }}</strong>
        <span class="muted mt-px block truncate text-xs">{{ role }}</span>
      </span>
      <Icon name="chevron" class="account-chevron size-4 shrink-0" />
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent class="menu account-menu" side="top" align="start" :side-offset="8" :collision-padding="8" loop>
        <DropdownMenuLabel class="account-identity">
          <span class="avatar size-9 shrink-0 text-xs" aria-hidden="true">{{ initials(name) }}</span>
          <span class="min-w-0">
            <strong class="block truncate text-sm font-semibold" :title="name">{{ name }}</strong>
            <span class="muted mt-1 block text-xs">{{ role }}</span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator class="account-separator" />
        <!-- Personal settings belong here once a working screen exists. Installation/project
             administration remains in its separate navigation; no placeholder action. -->
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
</template>
