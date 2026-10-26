<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import { SUCCESS_DURATION } from "../../composables/useNotice";
import { useChatStore } from "../../stores/chat";
import { useFoldersStore } from "../../stores/folders";
import MenuSelect from "../ui/MenuSelect.vue";

// The folder of the open dialogue, shared by the team, chosen in the dialogue's header (DialogueHeader.vue): a menu
// button with the folder's name, or where the header is short a folder icon named by it. A choice is shown at once and saved
// with the dialogue's folder revision, so a concurrent change by someone else is refused. What the saving says shows
// under the header, over the history: it takes no room; a success goes by itself, a failure stays.
const NONE = "none";
const chat = useChatStore();
const folders = useFoldersStore();
/** The header has little room (a phone, a narrow dialogue panel): an icon button instead of the folder's name. */
const props = defineProps<{ compact: boolean }>();
const pending = ref<string | null>(null);
const said = ref("");

const current = computed(() => chat.detail?.folder_id ?? NONE);
const loading = computed(() => !chat.detail && chat.opening);
const options = computed(() => {
  const list = [{ value: NONE, label: "Без папки" }, ...folders.folders.map((folder) => ({ value: folder.id, label: folder.name }))];
  // The detail can arrive before the folder list does: never show such a dialogue as unfiled.
  if (current.value !== NONE && !folders.folders.some((folder) => folder.id === current.value)) {
    list.push({ value: current.value, label: "Папка…" });
  }
  return list;
});

let timer: ReturnType<typeof setTimeout> | undefined;
watch(() => [chat.folderMove.status, chat.folderMove.failed] as const, ([status, failed]) => {
  clearTimeout(timer);
  said.value = status;
  if (status && !failed && !chat.folderMove.busy) timer = setTimeout(() => { said.value = ""; }, SUCCESS_DURATION);
}, { immediate: true });
onScopeDispose(() => clearTimeout(timer));

// Not disabled while a choice saves (a disabled button drops the keyboard focus): another choice waits for it.
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
  <div class="ticket-folder" :aria-busy="loading || undefined">
    <!-- The folder is the dialogue's detail: until it comes (an opening), a placeholder of the button's size, not
         "Без папки". A dialogue truly without a folder says so once its detail is here. -->
    <span v-if="loading" class="skeleton" :class="props.compact ? 'folder-icon-skeleton' : 'folder-select-skeleton'" aria-hidden="true" />
    <MenuSelect
      v-else
      :model-value="pending ?? current"
      :options="options"
      label="Папка диалога:"
      :icon="props.compact ? 'folder' : ''"
      align="end"
      :disabled="!chat.detail"
      @update:model-value="move"
    />
    <!-- Kept in the page while empty: a live region added with its text is not always announced. -->
    <p class="folder-status" role="status" :data-kind="said ? (chat.folderMove.failed ? 'error' : chat.folderMove.busy ? 'saving' : 'done') : undefined">{{ said }}</p>
  </div>
</template>
