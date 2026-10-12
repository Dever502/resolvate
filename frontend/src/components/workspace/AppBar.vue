<script setup lang="ts">
import { ref, watch } from "vue";
import { useProjectsStore } from "../../stores/projects";
import { useWorkspaceStore } from "../../stores/workspace";
import ReplyCatalog from "../composer/ReplyCatalog.vue";
import ProjectPicker from "../projects/ProjectPicker.vue";
import Icon from "../ui/Icon.vue";
import AdminMenu from "./AdminMenu.vue";

// Project choice on the left, the product mark in the centre (equal outer tracks keep it centred),
// administration and quick replies on the right. On narrow screens the project choice takes a row
// of its own and administration moves to the free left track. In an open dialogue on a narrow
// screen the bar shrinks to the project only.
const workspace = useWorkspaceStore();
const projects = useProjectsStore();
const catalogOpen = ref(false);
watch(() => projects.currentId, () => { catalogOpen.value = false; });
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
    <!-- On narrow screens this group dissolves into the grid: its items take the outer tracks. -->
    <div class="col-start-3 row-start-1 flex min-w-0 items-center justify-self-end gap-1 narrow:contents">
      <AdminMenu
        class="narrow:col-start-1 narrow:row-start-1 narrow:justify-self-start"
        :class="{ 'narrow:hidden': workspace.dialogueOpen }"
      />
      <button type="button" class="quiet text-sm text-white narrow:col-start-3 narrow:row-start-1 narrow:justify-self-end"
        :class="{ 'narrow:hidden': workspace.dialogueOpen }" aria-label="Управление готовыми ответами"
        :disabled="!projects.currentId" @click="catalogOpen = true"><span><span class="narrow:hidden">Готовые </span>ответы</span></button>
    </div>
    <ReplyCatalog v-if="projects.currentId" :key="projects.currentId" v-model:open="catalogOpen" :project-id="projects.currentId" />
  </header>
</template>
