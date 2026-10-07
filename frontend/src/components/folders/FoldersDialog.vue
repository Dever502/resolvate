<script setup lang="ts">
import { nextTick, ref, useTemplateRef, watch } from "vue";
import { ApiError } from "../../api/client";
import type { Folder } from "../../api/types";
import { useFoldersStore } from "../../stores/folders";
import ModalDialog from "../ui/ModalDialog.vue";
import FolderDeleteDialog from "./FolderDeleteDialog.vue";

// The team's folders of the current project: create, rename, delete (with confirmation).
const open = defineModel<boolean>("open", { required: true });
const folders = useFoldersStore();
const name = ref("");
const editing = ref<Folder | null>(null);
const deleting = ref<Folder | null>(null);
const confirmOpen = ref(false);
const status = ref("");
const success = ref(false);
const field = useTemplateRef<HTMLInputElement>("field");

function say(text: string, ok = false): void {
  status.value = text;
  success.value = ok;
}

function resetForm(): void {
  editing.value = null;
  name.value = "";
}

watch(open, (now) => {
  if (!now) return;
  resetForm();
  say("");
  folders.refresh().catch((error: unknown) => say(error instanceof Error ? error.message : String(error)));
});

async function run(action: () => Promise<void>): Promise<void> {
  say("");
  try {
    await action();
    resetForm();
    say("Изменения сохранены для всей команды.", true);
  } catch (error) {
    // Someone else renamed or deleted the folder meanwhile: start over with fresh data.
    if (error instanceof ApiError && (error.status === 409 || error.status === 404)) resetForm();
    say(error instanceof Error ? error.message : String(error));
  }
}

function submit(): void {
  if (folders.busy) return;
  const target = editing.value;
  void run(() => (target ? folders.rename(target, name.value) : folders.create(name.value)));
}

async function rename(folder: Folder): Promise<void> {
  if (folders.busy) return;
  editing.value = { ...folder };
  name.value = folder.name;
  say("");
  await nextTick();
  field.value?.focus();
}

function askDelete(folder: Folder): void {
  if (folders.busy) return;
  deleting.value = { ...folder };
  confirmOpen.value = true;
}

async function confirmDelete(): Promise<void> {
  const target = deleting.value;
  if (!target || folders.busy) return;
  await run(() => folders.remove(target));
  confirmOpen.value = false;
}
</script>

<template>
  <ModalDialog v-model:open="open" wide title="Общие папки" description="Для всей команды текущего проекта." close-label="Закрыть папки">
    <p class="error" :class="{ success }" role="alert">{{ status }}</p>
    <div class="mt-4 mb-6">
      <div v-for="folder in folders.folders" :key="folder.id" class="flex items-center gap-2 border-b border-border py-2.5">
        <strong class="min-w-0 flex-1 text-[.9375rem] [overflow-wrap:anywhere]">{{ folder.name }}</strong>
        <button class="quiet shrink-0" type="button" :aria-label="`Переименовать папку ${folder.name}`" @click="rename(folder)">
          Изменить
        </button>
        <button class="quiet shrink-0" type="button" :aria-label="`Удалить папку ${folder.name}`" @click="askDelete(folder)">
          Удалить
        </button>
      </div>
      <p v-if="!folders.folders.length" class="muted">Папок пока нет. Создайте первую ниже.</p>
    </div>
    <form @submit.prevent="submit">
      <label>
        {{ editing ? "Название папки" : "Новая папка" }}
        <input ref="field" v-model="name" name="name" required maxlength="80" autocomplete="off" />
      </label>
      <div class="mt-4 flex flex-wrap items-center justify-end gap-2">
        <button v-if="editing" class="quiet" type="button" @click="resetForm">Отмена</button>
        <button class="primary" type="submit" :aria-disabled="folders.busy || undefined">
          {{ editing ? "Сохранить" : "Создать" }}
        </button>
      </div>
    </form>
    <FolderDeleteDialog v-model:open="confirmOpen" :folder="deleting" @confirm="confirmDelete" />
  </ModalDialog>
</template>
