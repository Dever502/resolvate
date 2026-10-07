<script setup lang="ts">
import { computed, ref } from "vue";
import { initials } from "../lib/initials";
import { useSessionStore } from "../stores/session";
import ThemeToggle from "./ThemeToggle.vue";
import Icon from "./ui/Icon.vue";

const emit = defineEmits<{ error: [message: string] }>();
const session = useSessionStore();
const busy = ref(false);
const name = computed(() => session.account?.name ?? "");
const role = computed(() =>
  session.account?.role === "admin" ? "Администратор установки" : "Сотрудник",
);

async function logout(): Promise<void> {
  busy.value = true;
  try {
    await session.logout();
  } catch (caught) {
    emit("error", caught instanceof Error ? caught.message : String(caught));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <footer class="shrink-0 border-t border-border bg-footer px-4 pt-3.5 pb-[max(.75rem,env(safe-area-inset-bottom))]">
    <div class="flex min-w-0 items-center gap-2.5">
      <span class="avatar size-8 text-xs" aria-hidden="true">{{ initials(name) }}</span>
      <div class="min-w-0 flex-1">
        <strong class="block truncate text-[.8125rem] font-semibold">{{ name }}</strong>
        <span class="muted mt-px block truncate text-xs">{{ role }}</span>
      </div>
      <ThemeToggle />
    </div>
    <div class="mt-2.5 flex items-center gap-1">
      <button
        id="logout"
        class="quiet ml-auto min-h-8 px-2 py-1.5 text-xs coarse:min-h-11 coarse:min-w-11"
        type="button"
        aria-label="Выйти"
        title="Выйти"
        :disabled="busy"
        @click="logout"
      >
        <Icon name="logout" class="size-4" />
      </button>
    </div>
  </footer>
</template>
