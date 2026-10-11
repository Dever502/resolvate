<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useProjectsStore } from "../../stores/projects";
import { useWorkspaceStore, type ProjectTab } from "../../stores/workspace";
import ConfirmDialog from "../ui/ConfirmDialog.vue";
import ModalDialog from "../ui/ModalDialog.vue";
import ProjectList from "./ProjectList.vue";
import ProjectManagement from "./ProjectManagement.vue";

// "Проекты": the projects the account sees and, for one of them, its management screen with the way
// back to the list. Unsaved connections are never dropped silently: closing the window, going back
// to the list and leaving the page ask first.
const workspace = useWorkspaceStore();
const projects = useProjectsStore();
const view = computed(() => (workspace.admin?.window === "projects" ? workspace.admin : null));
const managedId = computed(() => view.value?.project ?? null);
const managed = computed(() => projects.all.find((project) => project.id === managedId.value) ?? null);
// Access or administration changed while the screen was open: the project left the list.
const gone = computed(() => Boolean(managedId.value) && projects.loaded && !managed.value);
const dirty = ref(false);
const discarding = ref<(() => void) | null>(null);
const discardOpen = computed({
  get: () => discarding.value !== null,
  set: (value) => { if (!value) discarding.value = null; },
});

function guard(action: () => void): void {
  if (dirty.value) discarding.value = action;
  else action();
}

function setOpen(value: boolean): void {
  if (!value) guard(() => workspace.closeAdmin());
}

function back(): void {
  guard(() => workspace.openProjects());
}

function manage(id: string, tab: ProjectTab = "members"): void {
  workspace.openProjects({ project: id, tab });
}

function discard(): void {
  const action = discarding.value;
  discarding.value = null;
  dirty.value = false;
  action?.();
}

// The browser asks before a reload or a closed tab drops unsaved connections.
function keep(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = "";
}
watch(dirty, (value) => {
  if (value) window.addEventListener("beforeunload", keep);
  else window.removeEventListener("beforeunload", keep);
});
watch(managed, (project) => {
  if (!project) dirty.value = false;
});
onBeforeUnmount(() => window.removeEventListener("beforeunload", keep));
</script>

<template>
  <ModalDialog
    :open="view !== null"
    :title="managed ? managed.name : 'Проекты'"
    :description="managed ? '' : 'У каждого проекта своя команда, обращения и подключения.'"
    wide
    @update:open="setOpen"
  >
    <ProjectManagement
      v-if="view && managed"
      :key="managed.id"
      v-model:dirty="dirty"
      :project="managed"
      :tab="view.tab"
      @back="back"
    />
    <ProjectList
      v-else-if="view"
      :create="view.create"
      :notice="gone ? 'Этот проект больше недоступен: изменились доступ или администратор.' : ''"
      @manage="manage"
    />
  </ModalDialog>
  <ConfirmDialog
    v-model:open="discardOpen"
    title="Не сохранять изменения?"
    description="Подключения проекта изменены, но не сохранены. Если уйти, изменения пропадут."
    confirm-label="Не сохранять"
    cancel-label="Вернуться к настройкам"
    danger
    @confirm="discard"
  />
</template>
