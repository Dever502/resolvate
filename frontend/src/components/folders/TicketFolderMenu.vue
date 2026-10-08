<script setup lang="ts">
import { computed, ref } from "vue";
import { useChatStore } from "../../stores/chat";
import { useFoldersStore } from "../../stores/folders";
import MenuSelect from "../ui/MenuSelect.vue";

// The folder of the open dialogue, shared by the team. A choice is shown at once and saved
// with the dialogue's folder revision, so a concurrent change by someone else is refused.
const NONE = "none";
const chat = useChatStore();
const folders = useFoldersStore();
const pending = ref<string | null>(null);

const current = computed(() => chat.detail?.folder_id ?? NONE);
const options = computed(() => {
  const list = [{ value: NONE, label: "Без папки" }, ...folders.folders.map((folder) => ({ value: folder.id, label: folder.name }))];
  // The detail can arrive before the folder list does: never show such a dialogue as unfiled.
  if (current.value !== NONE && !folders.folders.some((folder) => folder.id === current.value)) {
    list.push({ value: current.value, label: "Папка…" });
  }
  return list;
});

async function move(value: string): Promise<void> {
  if (value === current.value || chat.folderMove.busy) return;
  pending.value = value;
  try {
    await chat.moveToFolder(value === NONE ? null : value);
  } finally {
    pending.value = null;
  }
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2 compact:px-4 narrow:px-3">
    <span class="text-xs text-muted" aria-hidden="true">Папка</span>
    <MenuSelect
      class="max-w-[min(20rem,75%)]"
      :model-value="pending ?? current"
      :options="options"
      label="Папка диалога"
      :disabled="!chat.detail || chat.folderMove.busy"
      @update:model-value="move"
    />
    <span class="text-[.8125rem] text-muted" role="status">{{ chat.folderMove.status }}</span>
  </div>
</template>
