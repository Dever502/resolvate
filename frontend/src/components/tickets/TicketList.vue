<script setup lang="ts">
import { ListboxContent, ListboxItem, ListboxRoot } from "reka-ui";
import { nextTick, watch } from "vue";
import { useChatStore } from "../../stores/chat";
import { useProjectsStore } from "../../stores/projects";
import { useTicketsStore } from "../../stores/tickets";
import { useWorkspaceStore } from "../../stores/workspace";
import TicketRow from "./TicketRow.vue";

// One tab stop for the whole list: arrows, Home/End and typing move through the dialogues,
// Enter or a click opens one. The open dialogue is the selected option. A double-click is a mouse
// shortcut on top: its first click opens the dialogue at once, the double-click asks for its latest
// message (components/chat/MessageList.vue). A double-click selects no text in the row.
// Reka memoizes each option by its attributes: data-revision re-renders a row whose data changed.
const tickets = useTicketsStore();
const chat = useChatStore();
const projects = useProjectsStore();
const workspace = useWorkspaceStore();

function open(id: string): void {
  // The open dialogue is not loaded again by its own row (another click, the second click of a
  // double-click): its history keeps its place. On a phone, where the list covered it, the row shows
  // it again at its latest message. A dialogue that failed to open is opened again.
  if (id === chat.ticketId && (chat.opening || chat.detail)) {
    if (!workspace.dialogueOpen) {
      workspace.dialogueOpen = true;
      chat.jumpToLatest(id);
    }
    return;
  }
  chat.open(id).catch((error: unknown) => workspace.fail(error));
}

function noTextSelection(event: MouseEvent): void {
  if (event.detail > 1) event.preventDefault();
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
        @mousedown="noTextSelection"
        @dblclick="chat.jumpToLatest(ticket.id)"
      >
        <TicketRow :ticket="ticket" />
      </ListboxItem>
    </ListboxContent>
    <p v-if="tickets.loaded && !tickets.rows.length" class="list-empty">
      {{ tickets.query ? "Клиенты не найдены" : "Здесь пока нет диалогов" }}
    </p>
  </ListboxRoot>
</template>
