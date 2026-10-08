<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { initials } from "../../lib/initials";
import { useChatStore } from "../../stores/chat";
import { logoUrl, useProjectsStore } from "../../stores/projects";
import { useTicketsStore } from "../../stores/tickets";
import { useWorkspaceStore } from "../../stores/workspace";
import MenuSelect from "../ui/MenuSelect.vue";

// The project the workspace works in: its logo (or initial) and a menu of the available projects.
// Switching is blocked while a message is being sent.
const projects = useProjectsStore();
const chat = useChatStore();
const workspace = useWorkspaceStore();
const options = computed(() => projects.available.map((project) => ({ value: project.id, label: project.name })));
const logo = computed(() => (projects.current?.logo ? logoUrl(projects.current) : ""));
const logoFailed = ref(false);
watch(logo, () => {
  logoFailed.value = false;
});

function choose(id: string): void {
  if (id === projects.currentId || !projects.select(id)) return;
  useTicketsStore().sync().catch((error: unknown) => workspace.fail(error));
}
</script>

<template>
  <div class="flex min-w-0 flex-1 items-center gap-3">
    <div class="project-emblem" aria-hidden="true">
      <span>{{ initials(projects.current?.name || "R") }}</span>
      <img v-if="logo && !logoFailed" :src="logo" alt="" class="project-logo" @error="logoFailed = true" />
    </div>
    <div class="min-w-0 flex-1">
      <span class="mb-0.5 block text-xs text-chrome-muted" aria-hidden="true">Текущий проект</span>
      <MenuSelect
        tone="chrome"
        :model-value="projects.currentId ?? ''"
        :options="options"
        label="Текущий проект"
        placeholder="Выберите проект"
        :disabled="chat.sending || !options.length"
        @update:model-value="choose"
      />
    </div>
  </div>
</template>
