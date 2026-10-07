<script setup lang="ts">
import { ref } from "vue";
import AccountFooter from "./AccountFooter.vue";
import Icon from "./ui/Icon.vue";

// The frame of the workspace; the list, conversation and settings arrive in the next steps.
const notice = ref("");
</script>

<template>
  <div id="workspace" class="flex h-dvh flex-col overflow-hidden">
    <header
      class="grid min-h-[76px] shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-6 bg-chrome px-6 py-3.5 text-white compact:gap-4 compact:px-4 narrow:gap-x-2"
      aria-label="Проект и управление"
    >
      <div class="brand col-start-2 justify-self-center whitespace-nowrap text-xl narrow:text-lg">
        <span class="brand-mark bg-white text-selection" aria-hidden="true"><Icon name="resolve" /></span>
        Resolvate
      </div>
    </header>
    <div class="relative flex min-h-0 flex-1 overflow-hidden bg-canvas narrow:flex-col">
      <aside
        class="flex w-(--sidebar-width) min-w-[16.875rem] shrink-0 flex-col border-r border-border bg-surface narrow:w-full narrow:min-w-0 narrow:flex-1"
        aria-label="Список диалогов"
      >
        <header class="flex items-center justify-between gap-3 pt-6 pr-4 pb-1.5 pl-5 narrow:pt-5">
          <h1 class="m-0 text-[1.625rem] font-[650] tracking-[-.025em]">Диалоги</h1>
        </header>
        <div class="min-h-0 flex-1" />
        <AccountFooter @error="notice = $event" />
      </aside>
      <div class="flex min-h-0 min-w-0 flex-1 flex-col p-4 compact:p-3 narrow:hidden">
        <main
          class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-panel border border-border bg-surface"
        >
          <p v-if="notice" class="notice" role="alert">{{ notice }}</p>
        </main>
      </div>
    </div>
  </div>
</template>
