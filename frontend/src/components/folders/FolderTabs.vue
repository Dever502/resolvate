<script lang="ts">
/** Tab value of "all dialogues" (folder ids are UUIDs, so it cannot clash). */
export const ALL = "all";
</script>

<script setup lang="ts">
import { TabsList, TabsTrigger } from "reka-ui";
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, useTemplateRef, watch } from "vue";
import { useFoldersStore } from "../../stores/folders";
import { useProjectsStore } from "../../stores/projects";
import { useTicketsStore } from "../../stores/tickets";
import Icon from "../ui/Icon.vue";
import IconButton from "../ui/IconButton.vue";
import FoldersDialog from "./FoldersDialog.vue";

// Folder filter of the list: Reka tabs (arrows move, Enter or Space picks; the list is the panel)
// and the button that manages the team's folders. A vertical wheel scrolls the tabs sideways. The row
// scrolls without a visible scrollbar: an edge with tabs beyond it fades out instead (styles/app.css,
// .folder-tabs), and a focused tab is brought fully in, clear of the fades.
const folders = useFoldersStore();
const projects = useProjectsStore();
const tickets = useTicketsStore();
const managing = ref(false);
const list = useTemplateRef<InstanceType<typeof TabsList>>("list");

/** Tabs beyond the row's start or end edge: that edge fades out. */
const beyond = reactive({ start: false, end: false });

/** Reads where the row is scrolled; a pixel of rounding (zoom, fractional widths) is no overflow. */
function measure(): void {
  const element = list.value?.$el as HTMLElement | undefined;
  if (!element) return;
  beyond.start = element.scrollLeft > 1;
  beyond.end = element.scrollLeft < element.scrollWidth - element.clientWidth - 1;
}

// The row and each tab are watched for size: a resized sidebar or window, a phone's layout, a folder
// added, renamed or removed, a font loaded late. Scrolling is followed by the row's own scroll event.
const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
function observe(): void {
  const element = list.value?.$el as HTMLElement | undefined;
  if (!sizes || !element) return;
  sizes.disconnect();
  sizes.observe(element);
  for (const tab of element.children) sizes.observe(tab);
}
onMounted(() => {
  observe();
  measure();
});
onBeforeUnmount(() => sizes?.disconnect());
watch(() => folders.folders.map((folder) => folder.name), async () => {
  await nextTick();
  observe();
  measure();
});

/** A tab that takes the focus (arrows, Home/End, Tab) comes fully into view, past the fades (scroll padding). */
function reveal(event: FocusEvent): void {
  (event.target as HTMLElement).closest('[role="tab"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

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
    <TabsList ref="list" class="folder-tabs" aria-label="Папки диалогов" loop
      :data-beyond-start="beyond.start || undefined" :data-beyond-end="beyond.end || undefined"
      @wheel="onWheel" @scroll.passive="measure" @focusin="reveal">
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
      class="quiet shrink-0 p-2"
      label="Управление общими папками"
      :disabled="!projects.currentId"
      @click="managing = true"
    >
      <Icon name="folder" />
    </IconButton>
    <FoldersDialog v-model:open="managing" />
  </div>
</template>
