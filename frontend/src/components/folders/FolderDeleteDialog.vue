<script setup lang="ts">
import { useTemplateRef } from "vue";
import type { Folder } from "../../api/types";
import { useFoldersStore } from "../../stores/folders";
import ModalDialog from "../ui/ModalDialog.vue";

// Confirmation on top of the folders window; the safe choice, "Отмена", has focus.
const open = defineModel<boolean>("open", { required: true });
defineProps<{ folder: Folder | null }>();
const emit = defineEmits<{ confirm: [] }>();
const folders = useFoldersStore();
const cancel = useTemplateRef<HTMLButtonElement>("cancel");

function focusCancel(event: Event): void {
  event.preventDefault();
  cancel.value?.focus();
}
</script>

<template>
  <ModalDialog
    v-model:open="open"
    title="Удалить папку?"
    description="Папка исчезнет у всей команды. Диалоги останутся в общем списке, история сохранится."
    :locked="folders.busy"
    @open-auto-focus="focusCancel"
  >
    <p class="mt-4 font-semibold [overflow-wrap:anywhere]">{{ folder?.name }}</p>
    <div class="mt-4 flex flex-wrap items-center justify-end gap-2">
      <button ref="cancel" class="secondary" type="button" @click="open = false">Отмена</button>
      <button class="danger" type="button" :aria-disabled="folders.busy || undefined" @click="!folders.busy && emit('confirm')">
        Удалить папку
      </button>
    </div>
  </ModalDialog>
</template>
