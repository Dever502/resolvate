<script setup lang="ts">
import { useWorkspaceStore } from "../../stores/workspace";
import ProjectPicker from "../projects/ProjectPicker.vue";
import Icon from "../ui/Icon.vue";

// Project choice on the left, the product mark in the centre (equal outer tracks keep it centred).
// In an open dialogue on a narrow screen the bar shrinks to the project only.
const workspace = useWorkspaceStore();
</script>

<template>
  <header
    class="grid min-h-[76px] shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-6 bg-chrome px-6 py-3.5 text-white compact:gap-4 compact:px-4 narrow:gap-x-2 narrow:gap-y-4"
    :class="{ 'narrow:min-h-0 narrow:py-2': workspace.dialogueOpen }"
    aria-label="Проект и управление"
  >
    <ProjectPicker
      class="col-start-1 row-start-1 max-w-[calc(var(--sidebar-width)-3rem)] narrow:col-span-3 narrow:max-w-none"
      :class="workspace.dialogueOpen ? 'narrow:row-start-1' : 'narrow:row-start-2'"
    />
    <div
      class="brand col-start-2 row-start-1 min-w-0 justify-self-center whitespace-nowrap text-xl narrow:text-lg"
      :class="{ 'narrow:hidden': workspace.dialogueOpen }"
    >
      <span class="brand-mark bg-white text-selection" aria-hidden="true"><Icon name="resolve" /></span>
      Resolvate
    </div>
  </header>
</template>
