<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import type { Project } from "../../api/types";
import { errorMessage, useRequest } from "../../composables/useRequest";
import { initials } from "../../lib/initials";
import { logoUrl, useProjectsStore } from "../../stores/projects";
import { useSessionStore } from "../../stores/session";
import { useStaffStore } from "../../stores/staff";
import { useTicketsStore } from "../../stores/tickets";
import { useWorkspaceStore } from "../../stores/workspace";
import ConfirmDialog from "../ui/ConfirmDialog.vue";
import ProjectCreateForm from "./ProjectCreateForm.vue";

// The projects the account sees, with their state and what this account may do with each: open
// it in the workspace, manage it, switch it on or off, or grant oneself access (installation
// administrator). The server checks every action again.
const props = defineProps<{ create: boolean; notice: string }>();
const emit = defineEmits<{ manage: [id: string] }>();
const session = useSessionStore();
const projects = useProjectsStore();
const staff = useStaffStore();
const workspace = useWorkspaceStore();
const owner = computed(() => session.account?.role === "admin");
const manages = computed(() => owner.value || projects.all.some((project) => project.role === "admin"));
const request = useRequest();
const confirm = useRequest();
const disabling = ref<Project | null>(null);
const disablingOpen = computed({
  get: () => disabling.value !== null,
  set: (value) => { if (!value && !confirm.busy) disabling.value = null; },
});
const loading = ref(false);
const loadError = ref("");
const brokenLogos = reactive(new Set<string>());

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    await projects.refresh(false);
  } catch (error) {
    loadError.value = errorMessage(error);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
  // Names of project administrators; without them the list still works.
  if (owner.value) staff.refresh().catch(() => undefined);
});

function relation(project: Project): string {
  if (project.role === "admin") return "Вы — администратор проекта";
  if (project.role === "operator") return "Вы — оператор";
  return "Доступ к переписке не выдан";
}

function adminName(project: Project): string {
  if (project.admin_id === session.account?.id) return "";
  return staff.accounts.find((account) => account.id === project.admin_id)?.name ?? "";
}

function open(project: Project): void {
  if (project.id !== projects.currentId) {
    if (!projects.select(project.id)) {
      request.status = "Дождитесь окончания отправки сообщения.";
      request.failed = true;
      return;
    }
    useTicketsStore().sync().catch((error: unknown) => workspace.fail(error));
  }
  workspace.closeAdmin();
}

function join(project: Project): void {
  void request.run(async () => {
    await projects.grant(project.id, session.account?.login ?? "");
    return `Вы получили доступ к переписке проекта «${project.name}».`;
  });
}

function toggle(project: Project): void {
  if (request.busy) return;
  if (project.active) {
    confirm.clear();
    disabling.value = project;
    return;
  }
  void request.run(async () => {
    await projects.setActive(project.id, true);
    return `Проект «${project.name}» включён.`;
  });
}

async function disable(): Promise<void> {
  const project = disabling.value;
  if (!project) return;
  const done = await confirm.run(() => projects.setActive(project.id, false));
  if (!done) return;
  disabling.value = null;
  request.clear();
  request.status = `Проект «${project.name}» выключен. Данные и настройки сохранены.`;
}
</script>

<template>
  <div>
    <p v-if="props.notice" class="error" role="alert">{{ props.notice }}</p>
    <p class="muted small mt-3 mb-0">
      <template v-if="owner">Вы администратор установки: создаёте проекты, назначаете их администраторов и включаете проекты. Доступ к переписке выдаётся явно, выдача доступа себе записывается в журнал.</template>
      <template v-else-if="manages">Вы управляете участниками и подключениями проектов, где вы администратор. Включает и выключает проекты администратор установки.</template>
      <template v-else>Управлять проектами может администратор установки или администратор проекта.</template>
    </p>
    <p v-if="request.status" class="error" :class="{ success: !request.failed }" :role="request.failed ? 'alert' : 'status'">{{ request.status }}</p>
    <p v-if="!projects.loaded && loadError" class="error" role="alert">
      {{ loadError }}
      <button type="button" class="quiet ml-1" :aria-disabled="loading || undefined" @click="!loading && load()">Повторить</button>
    </p>
    <p v-else-if="!projects.loaded" class="muted">Загружаем проекты…</p>
    <ul v-else-if="projects.all.length" class="admin-list" aria-label="Проекты">
      <li v-for="project in projects.all" :key="project.id" class="admin-row">
        <div class="project-emblem" aria-hidden="true">
          <span>{{ initials(project.name) }}</span>
          <img v-if="project.logo && !brokenLogos.has(project.id)" :src="logoUrl(project)" alt="" class="project-logo" @error="brokenLogos.add(project.id)" />
        </div>
        <div class="min-w-0 flex-1">
          <p class="admin-row-title">
            <span class="[overflow-wrap:anywhere]">{{ project.name }}</span>
            <span class="pill" :class="project.active ? 'pill-on' : 'pill-off'">{{ project.active ? "Включён" : "Выключен" }}</span>
          </p>
          <p class="muted small m-0">{{ relation(project) }}<template v-if="adminName(project)"> · администратор: {{ adminName(project) }}</template></p>
        </div>
        <div class="admin-actions">
          <button v-if="project.role && project.active" type="button" class="secondary" :aria-label="`Открыть проект ${project.name}`" @click="open(project)">Открыть</button>
          <button v-if="owner || project.role === 'admin'" type="button" class="secondary" :aria-label="`Настроить проект ${project.name}`" @click="emit('manage', project.id)">Настроить</button>
          <button v-if="owner && !project.role" type="button" class="quiet" :aria-disabled="request.busy || undefined"
            :aria-label="`Выдать себе доступ к проекту ${project.name}`" @click="!request.busy && join(project)">Выдать себе доступ</button>
          <button v-if="owner" type="button" class="quiet" :aria-disabled="request.busy || undefined"
            :aria-label="`${project.active ? 'Выключить' : 'Включить'} проект ${project.name}`" @click="toggle(project)">
            {{ project.active ? "Выключить" : "Включить" }}
          </button>
        </div>
      </li>
    </ul>
    <p v-else class="muted">{{ owner ? "Проектов пока нет. Создайте первый проект." : "Проектов, к которым у вас есть доступ, пока нет." }}</p>
    <details v-if="owner" class="disclosure" :open="props.create || (projects.loaded && !projects.all.length)">
      <summary>Новый проект</summary>
      <ProjectCreateForm />
    </details>
    <ConfirmDialog
      v-model:open="disablingOpen"
      :title="`Выключить проект «${disabling?.name ?? ''}»?`"
      description="Бот и API проекта остановятся, операторы не смогут открыть переписку. Данные и настройки сохранятся, проект можно включить снова."
      confirm-label="Выключить проект"
      busy-label="Выключаем…"
      :busy="confirm.busy"
      :error="confirm.failed ? confirm.status : ''"
      danger
      @confirm="disable"
    />
  </div>
</template>
