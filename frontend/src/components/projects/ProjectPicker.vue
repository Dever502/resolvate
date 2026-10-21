<script lang="ts">
import { useProjectsStore } from "../../stores/projects";
import { useTicketsStore } from "../../stores/tickets";

/**
 * Switches the workspace to another project (the app bar's menu, the narrow screens' drawer). Refused
 * while a message is being sent (projects.select); the new project's list loads at once.
 */
export function chooseProject(id: string, fail: (error: unknown) => void): void {
  const projects = useProjectsStore();
  if (id === projects.currentId || !projects.select(id)) return;
  useTicketsStore().sync().catch(fail);
}
</script>

<script setup lang="ts">
import { computed } from "vue";
import { useChatStore } from "../../stores/chat";
import { useWorkspaceStore } from "../../stores/workspace";
import MenuSelect from "../ui/MenuSelect.vue";
import ProjectEmblem from "./ProjectEmblem.vue";

// The project the workspace works in: its logo (or initial) and a menu of the available projects.
// Switching is blocked while a message is being sent. Until the project list has loaded (and the tab's
// project is restored) the picker keeps its shape as a placeholder: no "Выберите проект" in between.
const projects = useProjectsStore();
const chat = useChatStore();
const workspace = useWorkspaceStore();
const options = computed(() => projects.available.map((project) => ({ value: project.id, label: project.name })));
const loading = computed(() => !projects.loaded && !projects.error);
</script>

<template>
  <div class="flex min-w-0 flex-1 items-center gap-3" :aria-busy="loading || undefined">
    <template v-if="loading">
      <span class="skeleton project-emblem-skeleton" aria-hidden="true" />
      <!-- As tall as the caption and the menu button it stands for. -->
      <span class="flex h-11 min-w-0 flex-1 flex-col justify-center" aria-hidden="true">
        <span class="skeleton mb-1.5 h-3 w-24" />
        <span class="skeleton h-4 w-36 max-w-full" />
      </span>
      <span class="sr-only">Проект загружается</span>
    </template>
    <template v-else>
      <ProjectEmblem :project="projects.current" />
      <!-- The menu button reaches up over this caption (app.css, .project-picker): with it, a hit area of 44 px. -->
      <div class="project-picker min-w-0 flex-1">
        <span class="mb-0.5 block text-xs text-chrome-muted" aria-hidden="true">Текущий проект</span>
        <MenuSelect
          tone="chrome"
          :model-value="projects.currentId ?? ''"
          :options="options"
          label="Текущий проект"
          :placeholder="projects.error ? 'Проекты не загрузились' : 'Выберите проект'"
          :disabled="chat.sending || !options.length"
          @update:model-value="(id) => chooseProject(id, workspace.fail)"
        />
      </div>
    </template>
  </div>
</template>
