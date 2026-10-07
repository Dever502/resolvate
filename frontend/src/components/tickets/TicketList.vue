<script setup lang="ts">
import { ListboxContent, ListboxItem, ListboxRoot } from "reka-ui";
import { nextTick, watch } from "vue";
import { useChatStore } from "../../stores/chat";
import { useProjectsStore } from "../../stores/projects";
import { useTicketsStore } from "../../stores/tickets";
import { useWorkspaceStore } from "../../stores/workspace";
import TicketRow from "./TicketRow.vue";

// One tab stop for the whole list: arrows, Home/End and typing move through the dialogues,
// Enter or a click opens one. The open dialogue is the selected option.
// Reka memoizes each option by its attributes: data-revision re-renders a row whose data changed.
const tickets = useTicketsStore();
const chat = useChatStore();
const projects = useProjectsStore();
const workspace = useWorkspaceStore();

function open(id: string): void {
  chat.open(id).catch((error: unknown) => workspace.fail(error));
}

// "Back" on a narrow screen hides the dialogue that held focus: continue from its row in the list.
watch(() => workspace.dialogueOpen, async (open, was) => {
  if (open || !was) return;
  await nextTick();
  // The hidden back button may still count as focused here; only focus already in the list stays.
  if (document.getElementById("ticket-sidebar")?.contains(document.activeElement)) return;
  document.querySelector<HTMLElement>('#ticket-list [role="option"][aria-selected="true"]')?.focus();
});
</script>

<template>
  <ListboxRoot
    v-if="projects.currentId"
    id="ticket-list"
    class="min-h-0 flex-1 overflow-auto px-2.5 pt-1 pb-4 [scrollbar-width:thin]"
    :model-value="chat.ticketId"
    selection-behavior="replace"
  >
    <ListboxContent class="outline-none" aria-label="Диалоги">
      <ListboxItem
        v-for="ticket in tickets.rows"
        :key="ticket.id"
        :value="ticket.id"
        class="ticket"
        :class="{ unread: ticket.unread > 0 }"
        :data-revision="ticket.revision"
        @select="open(ticket.id)"
      >
        <TicketRow :ticket="ticket" />
      </ListboxItem>
    </ListboxContent>
    <p v-if="tickets.loaded && !tickets.rows.length" class="list-empty">
      {{ tickets.query ? "Клиенты не найдены" : "Здесь пока нет диалогов" }}
    </p>
  </ListboxRoot>
</template>
