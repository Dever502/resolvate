<script setup lang="ts">
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { Project } from "../../api/types";
import { useSessionStore } from "../../stores/session";
import type { ProjectTab } from "../../stores/workspace";
import Icon from "../ui/Icon.vue";
import ProjectMembers from "./ProjectMembers.vue";
import ProjectSettingsForm from "./ProjectSettingsForm.vue";

// One project's management screen inside the projects window. Members are managed by the
// installation administrator and the project administrator; connections only by the project
// administrator (the server answers 403 to anyone else). Hidden tabs stay mounted, so switching
// tabs keeps unsaved connections, and the members tab stays mounted when administration changes.
const props = defineProps<{ project: Project; tab: ProjectTab }>();
const dirty = defineModel<boolean>("dirty", { required: true });
const emit = defineEmits<{ back: [] }>();
const session = useSessionStore();
const owner = computed(() => session.account?.role === "admin");
const projectAdmin = computed(() => props.project.role === "admin");
const tab = ref<string>(projectAdmin.value ? props.tab : "members");
const summary = computed(() => {
  const state = props.project.active ? "Включён" : "Выключен";
  if (projectAdmin.value) return `${state} · вы администратор проекта`;
  return `${state} · ${props.project.role ? "вы оператор" : "доступ к переписке у вас не выдан"}`;
});

// Administration handed over to someone else: only the members remain.
watch(projectAdmin, (value) => {
  if (!value) tab.value = "members";
});
onBeforeUnmount(() => {
  dirty.value = false;
});
</script>

<template>
  <div>
    <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      <button type="button" class="quiet -ml-2.5" @click="emit('back')">
        <Icon name="back" />
        Все проекты
      </button>
      <span class="pill" :class="project.active ? 'pill-on' : 'pill-off'">{{ summary }}</span>
    </div>
    <p v-if="owner && !projectAdmin" class="muted small mt-3 mb-0">
      Подключения и логотип настраивает администратор проекта. Чтобы настроить их самостоятельно, назначьте администратором себя.
    </p>
    <TabsRoot v-model="tab" :unmount-on-hide="false" class="mt-4">
      <TabsList class="section-tabs" aria-label="Управление проектом">
        <TabsTrigger value="members" class="section-tab">Участники</TabsTrigger>
        <TabsTrigger v-if="projectAdmin" value="settings" class="section-tab">Подключения</TabsTrigger>
      </TabsList>
      <!-- Panels start with their own fields, so they are not Tab stops themselves. -->
      <TabsContent value="members" as-child>
        <div class="pt-4 outline-none" tabindex="-1"><ProjectMembers :project="project" /></div>
      </TabsContent>
      <TabsContent v-if="projectAdmin" value="settings" as-child>
        <div class="pt-4 outline-none" tabindex="-1"><ProjectSettingsForm v-model:dirty="dirty" :project="project" /></div>
      </TabsContent>
    </TabsRoot>
  </div>
</template>
