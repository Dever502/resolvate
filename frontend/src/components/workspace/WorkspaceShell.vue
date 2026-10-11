<script setup lang="ts">
import { computed, defineAsyncComponent, defineComponent, onMounted, reactive, useTemplateRef, type Component } from "vue";
import { useLiveUpdates } from "../../composables/useLiveUpdates";
import { useSidebarResize } from "../../composables/useSidebarResize";
import { WINDOW_UNAVAILABLE, useWorkspaceStore } from "../../stores/workspace";
import ConversationPanel from "../chat/ConversationPanel.vue";
import TicketSidebar from "../tickets/TicketSidebar.vue";
import AppBar from "./AppBar.vue";
import SidebarResizer from "./SidebarResizer.vue";

// The workspace frame: app bar, the ticket list and the conversation side by side, with a
// separator between them. Narrow screens show the list or the dialogue, one at a time. The
// administration windows open over it from the app bar and from the empty states; their code loads
// only when one opens, so the operators' bundle does not carry it.
const workspace = useWorkspaceStore();
// A window whose code cannot be loaded (an old tab after a deploy) closes and says so; the
// workspace and its drafts stay.
const Unavailable = defineComponent({
  setup() {
    onMounted(() => {
      workspace.closeAdmin();
      workspace.show(WINDOW_UNAVAILABLE);
    });
    return () => null;
  },
});
const windowOf = (load: () => Promise<{ default: Component }>) => defineAsyncComponent(() => load().catch(() => Unavailable));
const ProjectsDialog = windowOf(() => import("../projects/ProjectsDialog.vue"));
const StaffDialog = windowOf(() => import("../staff/StaffDialog.vue"));
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
    <ProjectsDialog v-if="workspace.admin?.window === 'projects'" />
    <StaffDialog v-else-if="workspace.admin?.window === 'staff'" />
  </div>
</template>
