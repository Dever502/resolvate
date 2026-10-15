<script setup lang="ts">
import { computed, ref, useTemplateRef, watch } from "vue";
import { useFileDrop } from "../../composables/useFileDrop";
import { MAX_FILES } from "../../lib/attachment";
import { useChatStore } from "../../stores/chat";
import { useProjectsStore } from "../../stores/projects";
import { useWorkspaceStore } from "../../stores/workspace";
import Composer from "../composer/Composer.vue";
import TicketFolderMenu from "../folders/TicketFolderMenu.vue";
import ProjectsEmptyState from "../projects/ProjectsEmptyState.vue";
import Icon from "../ui/Icon.vue";
import CustomerCard from "./CustomerCard.vue";
import DialogueHeader from "./DialogueHeader.vue";
import ImageViewer from "./ImageViewer.vue";
import MessageList from "./MessageList.vue";

// The right side of the workspace: notices, then either the open dialogue or an empty state.
const chat = useChatStore();
const projects = useProjectsStore();
const workspace = useWorkspaceStore();
const cardOpen = ref(false);
watch(() => chat.ticketId, () => {
  cardOpen.value = false;
});

// Files dragged onto this panel go into the open dialogue's draft through the picker's own check
// (chat.attach, lib/attachment.ts). The ticket list, the app bar and the windows take no files.
const DROP_HINT = "Перетащите файлы для прикрепления";
// Why a file is not taken now: shown over the panel while it is dragged, said if it is dropped anyway.
// The attach button is off in two of these states (the draft not read yet, a send running); in the
// others the file would land in no dialogue, in one that is gone (403/404) or behind a window.
const DROP_NO_DIALOGUE = "Откройте диалог, чтобы прикрепить файл.";
const DROP_IN_WINDOW = "Закройте окно, чтобы прикрепить файл.";
const DROP_UNAVAILABLE = "Диалог недоступен: прикрепить файл нельзя.";
const DROP_LOADING = "Черновик диалога ещё загружается: перетащите файл чуть позже.";
const DROP_SENDING = "Идёт отправка: перетащите файл, когда она закончится.";
const DROP_SWITCHED = "Диалог сменился во время перетаскивания: перетащите файл снова.";
const DROP_FULL = `В ответе уже ${MAX_FILES} файлов: уберите лишний, чтобы прикрепить другой.`;
const panel = useTemplateRef<HTMLElement>("panel");

/** A modal window over the workspace (Reka Dialog or AlertDialog): a file dropped now would land out of sight. */
function windowOpen(): boolean {
  return document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]') !== null;
}

function dropRefusal(count: number | null): string | null {
  if (!chat.ticketId) return DROP_NO_DIALOGUE;
  if (windowOpen()) return DROP_IN_WINDOW;
  if (chat.unavailable) return DROP_UNAVAILABLE;
  if (!chat.draft) return DROP_LOADING;
  if (chat.sending) return DROP_SENDING;
  return chat.draft.files.length >= MAX_FILES ? DROP_FULL : null;
}

const files = useFileDrop(panel, {
  refusal: dropRefusal,
  // As from the picker: the ones refused are named, the others attached after the draft's own.
  accept: (dropped) => chat.attach(dropped),
  refuse: (reason) => workspace.show(reason),
});
const dragging = files.over;
const dropReason = computed(() => (dragging.value ? dropRefusal(files.count.value) : null));
/** More files than the reply has room for: the first ones are attached, the rest named as refused. */
const dropHint = computed(() => {
  const room = MAX_FILES - (chat.draft?.files.length ?? 0);
  const count = files.count.value;
  return count !== null && count > room ? `Прикрепятся ${room} из ${count}: к одному ответу — не больше ${MAX_FILES} файлов.` : DROP_HINT;
});
// Another dialogue (or none) under the drag: the highlight goes, and its drop does not land there unseen.
watch(() => [chat.ticketId, projects.currentId], () => files.interrupt(DROP_SWITCHED));
</script>

<template>
  <div class="relative flex min-h-0 min-w-0 flex-1">
    <div class="flex min-h-0 min-w-0 flex-1 flex-col p-4 compact:p-3 narrow:p-0">
      <main
        ref="panel"
        class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-panel border border-border bg-surface narrow:rounded-none narrow:border-0"
        @dragenter="files.onDragEnter"
        @dragover="files.onDragOver"
        @dragleave="files.onDragLeave"
        @drop="files.onDrop"
        @dragend="files.onDragEnd"
      >
        <!-- A project list that failed to load is explained by the empty state instead. -->
        <p v-if="workspace.notice && (projects.loaded || !projects.error)" class="notice" role="alert">{{ workspace.notice }}</p>
        <section v-if="chat.ticketId" class="flex min-h-0 flex-1 flex-col" aria-label="Диалог">
          <DialogueHeader v-model:card-open="cardOpen" />
          <TicketFolderMenu />
          <MessageList />
          <Composer />
        </section>
        <div v-else-if="projects.currentId" class="m-auto max-w-md p-8 text-center text-muted">
          <Icon name="chat" class="mx-auto mb-6 block size-11 text-accent [stroke-width:1.25]" />
          <h2 class="mb-2.5 text-[1.375rem] text-text">Выберите диалог</h2>
          <p class="m-0 text-[.9375rem]">Здесь появится история обращения.</p>
        </div>
        <ProjectsEmptyState v-else />
        <!-- Shown only while files are dragged over the panel; decoration that never takes the pointer. -->
        <div v-if="dragging" class="drop-zone" :data-refused="dropReason ? '' : undefined" aria-hidden="true">
          <p class="drop-zone-label">{{ dropReason ?? dropHint }}</p>
        </div>
      </main>
    </div>
    <CustomerCard v-if="chat.ticketId && cardOpen" v-model:open="cardOpen" />
    <ImageViewer />
  </div>
</template>
