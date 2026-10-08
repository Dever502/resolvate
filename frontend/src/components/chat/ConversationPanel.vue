<script setup lang="ts">
import { ref, watch } from "vue";
import { useChatStore } from "../../stores/chat";
import { useProjectsStore } from "../../stores/projects";
import { useWorkspaceStore } from "../../stores/workspace";
import Composer from "../composer/Composer.vue";
import TicketFolderMenu from "../folders/TicketFolderMenu.vue";
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
</script>

<template>
  <div class="relative flex min-h-0 min-w-0 flex-1">
    <div class="flex min-h-0 min-w-0 flex-1 flex-col p-4 compact:p-3 narrow:p-0">
      <main class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-panel border border-border bg-surface narrow:rounded-none narrow:border-0">
        <p v-if="workspace.notice" class="notice" role="alert">{{ workspace.notice }}</p>
        <section v-if="chat.ticketId" class="flex min-h-0 flex-1 flex-col" aria-label="Диалог">
          <DialogueHeader v-model:card-open="cardOpen" />
          <TicketFolderMenu />
          <MessageList />
          <Composer />
        </section>
        <div v-else class="m-auto max-w-md p-8 text-center text-muted">
          <Icon name="chat" class="mx-auto mb-6 block size-11 text-accent [stroke-width:1.25]" />
          <h2 class="mb-2.5 text-[1.375rem] text-text">{{ projects.currentId ? "Выберите диалог" : "Нет активного проекта" }}</h2>
          <p class="m-0 text-[.9375rem]">
            {{ projects.currentId ? "Здесь появится история обращения." : "Попросите администратора выдать доступ к проекту." }}
          </p>
        </div>
      </main>
    </div>
    <CustomerCard v-if="chat.ticketId && cardOpen" v-model:open="cardOpen" />
    <ImageViewer />
  </div>
</template>
