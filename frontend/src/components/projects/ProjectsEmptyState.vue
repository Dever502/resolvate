<script setup lang="ts">
import { computed, ref } from "vue";
import { useProjectsStore } from "../../stores/projects";
import { useSessionStore } from "../../stores/session";
import { useWorkspaceStore } from "../../stores/workspace";
import Icon from "../ui/Icon.vue";

// Why the workspace has no project, and the next step this account can take. The states follow the
// project list and the account's role; the server decides what each step may actually change.
const session = useSessionStore();
const projects = useProjectsStore();
const workspace = useWorkspaceStore();
const retrying = ref(false);
const owner = computed(() => session.account?.role === "admin");
const configurable = computed(() => projects.all.find((project) => project.role === "admin" && !project.active) ?? null);

interface EmptyState {
  title: string;
  text: string;
  action?: { label: string; run: () => void };
}

const state = computed<EmptyState>(() => {
  if (!projects.loaded) {
    return projects.error
      ? { title: "Не удалось загрузить проекты", text: projects.error, action: { label: "Повторить", run: retry } }
      : { title: "Загружаем проекты…", text: "" };
  }
  if (projects.available.length) {
    return { title: "Выберите проект", text: "Проект выбирается в шапке, в поле «Текущий проект»." };
  }
  if (!projects.all.length) {
    return owner.value
      ? { title: "Создайте первый проект", text: "В установке ещё нет проектов. Создайте проект и назначьте его администратора: он подключит бота и группу поддержки.", action: { label: "Создать проект", run: () => workspace.openProjects({ create: true }) } }
      : { title: "Нет доступа к проектам", text: "Вам ещё не выдали доступ ни к одному проекту. Обратитесь к администратору установки или проекта." };
  }
  if (projects.all.some((project) => project.role && !project.active)) {
    if (owner.value) {
      return { title: "Ваши проекты выключены", text: "Включите проект в разделе «Проекты». Включить можно проект, у которого настроены бот и группа поддержки.", action: { label: "Открыть проекты", run: () => workspace.openProjects() } };
    }
    if (configurable.value) {
      const project = configurable.value;
      return { title: "Проект выключен", text: `Настройте бота и группу поддержки в подключениях проекта «${project.name}», затем попросите администратора установки включить его.`, action: { label: "Настроить проект", run: () => workspace.openProjects({ project: project.id, tab: "settings" }) } };
    }
    return { title: "Проект выключен", text: "Проект, к которому у вас есть доступ, выключен. Работа продолжится, когда администратор установки включит его." };
  }
  // Only the installation administrator sees projects without being their member.
  return { title: "Нет доступа к переписке", text: "Проекты есть, но вы не участник ни одного. Доступ к переписке выдаётся явно: выдайте его себе в разделе «Проекты».", action: { label: "Открыть проекты", run: () => workspace.openProjects() } };
});

async function retry(): Promise<void> {
  if (retrying.value) return;
  retrying.value = true;
  try {
    await workspace.enter();
  } catch (error) {
    // A failed list stays in this state; a failure after it is reported like any other.
    if (projects.loaded) workspace.fail(error);
  } finally {
    retrying.value = false;
  }
}
</script>

<template>
  <div class="m-auto max-w-md p-8 text-center text-muted">
    <Icon name="chat" class="mx-auto mb-6 block size-11 text-accent [stroke-width:1.25]" />
    <h2 class="mb-2.5 text-[1.375rem] text-text">{{ state.title }}</h2>
    <p v-if="state.text" class="m-0 text-[.9375rem]">{{ state.text }}</p>
    <button v-if="state.action" type="button" class="primary mt-6" :aria-disabled="retrying || undefined" @click="!retrying && state.action.run()">
      {{ retrying ? "Загружаем…" : state.action.label }}
    </button>
  </div>
</template>
