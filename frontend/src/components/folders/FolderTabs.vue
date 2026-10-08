<script lang="ts">
/** Tab value of "all dialogues" (folder ids are UUIDs, so it cannot clash). */
export const ALL = "all";
</script>

<script setup lang="ts">
import { TabsList, TabsTrigger } from "reka-ui";
import { nextTick, ref, useTemplateRef, watch } from "vue";
import { useFoldersStore } from "../../stores/folders";
import { useProjectsStore } from "../../stores/projects";
import { useTicketsStore } from "../../stores/tickets";
import Icon from "../ui/Icon.vue";
import IconButton from "../ui/IconButton.vue";
import FoldersDialog from "./FoldersDialog.vue";

// Folder filter of the list: Reka tabs (arrows move, Enter or Space picks; the list is the panel)
// and the button that manages the team's folders. A vertical wheel scrolls the tabs sideways.
const folders = useFoldersStore();
const projects = useProjectsStore();
const tickets = useTicketsStore();
const managing = ref(false);
const list = useTemplateRef<InstanceType<typeof TabsList>>("list");

function onWheel(event: WheelEvent): void {
  const element = list.value?.$el as HTMLElement | undefined;
  if (!element || event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1;
  const next = Math.max(0, Math.min(element.scrollWidth - element.clientWidth, element.scrollLeft + event.deltaY * scale));
  if (next !== element.scrollLeft) {
    event.preventDefault();
    element.scrollLeft = next;
  }
}

// A filter reset elsewhere (a folder deleted by someone else) keeps the active tab in view.
watch(() => tickets.folderFilter, async () => {
  await nextTick();
  (list.value?.$el as HTMLElement | undefined)?.querySelector('[data-state="active"]')
    ?.scrollIntoView({ block: "nearest", inline: "nearest" });
});
</script>

<template>
  <div class="my-2 flex shrink-0 items-center gap-1.5 border-b border-border">
    <TabsList ref="list" class="folder-tabs" aria-label="Папки диалогов" loop @wheel="onWheel">
      <TabsTrigger :value="ALL" class="folder-tab" :disabled="!projects.currentId">Все</TabsTrigger>
      <TabsTrigger
        v-for="folder in folders.folders"
        :key="folder.id"
        :value="folder.id"
        class="folder-tab"
        :title="folder.name"
        :disabled="!projects.currentId"
      >
        {{ folder.name }}
      </TabsTrigger>
    </TabsList>
    <IconButton
      class="quiet min-h-11 min-w-11 shrink-0 p-2"
      label="Управление общими папками"
      :disabled="!projects.currentId"
      @click="managing = true"
    >
      <Icon name="folder" />
    </IconButton>
    <FoldersDialog v-model:open="managing" />
  </div>
</template>
