<script setup lang="ts">
import { computed, onMounted, reactive, useTemplateRef } from "vue";
import { useLiveUpdates } from "../../composables/useLiveUpdates";
import { useSidebarResize } from "../../composables/useSidebarResize";
import { useWorkspaceStore } from "../../stores/workspace";
import ConversationPanel from "../chat/ConversationPanel.vue";
import TicketSidebar from "../tickets/TicketSidebar.vue";
import AppBar from "./AppBar.vue";
import SidebarResizer from "./SidebarResizer.vue";

// The workspace frame: app bar, the ticket list and the conversation side by side, with a
// separator between them. Narrow screens show the list or the dialogue, one at a time.
const workspace = useWorkspaceStore();
const sidebar = useTemplateRef<InstanceType<typeof TicketSidebar>>("sidebar");
const resize = reactive(useSidebarResize(computed(() => (sidebar.value?.$el as HTMLElement | undefined) ?? null)));

useLiveUpdates();
onMounted(() => {
  workspace.enter().catch((error: unknown) => workspace.fail(error));
});
</script>

<template>
  <div
    id="workspace"
    class="flex h-dvh flex-col overflow-hidden"
    :class="{ 'resizing-sidebar': resize.dragging }"
    :style="resize.style"
  >
    <AppBar />
    <div class="relative flex min-h-0 flex-1 overflow-hidden bg-canvas narrow:flex-col">
      <TicketSidebar ref="sidebar" :class="{ 'narrow:hidden': workspace.dialogueOpen }" />
      <SidebarResizer :resize="resize" />
      <ConversationPanel :class="workspace.dialogueOpen ? 'narrow:flex' : 'narrow:hidden'" />
    </div>
  </div>
</template>
