<script setup lang="ts">
import { DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle, DialogTrigger, RadioGroupItem, RadioGroupRoot } from "reka-ui";
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import { useChatStore } from "../../stores/chat";
import { useProjectsStore } from "../../stores/projects";
import { useWorkspaceStore } from "../../stores/workspace";
import AccountMenu from "../account/AccountMenu.vue";
import ProjectEmblem from "../projects/ProjectEmblem.vue";
import { chooseProject } from "../projects/ProjectPicker.vue";
import Icon from "../ui/Icon.vue";
import { adminAccess } from "./AdminMenu.vue";

// Narrow screens: the app bar is one row, this button with the current project's emblem and name.
// It opens a drawer from the left (a Reka dialog: focus trapped, Esc and the backdrop close it, focus
// returns to the button) with what the wide app bar and the list's account footer hold: the project
// choice, administration by role, the quick replies catalog and the account (the same AccountMenu, its
// sign-out, password and theme). An action that opens a window runs once the drawer has closed and the
// button has the focus again, so closing that window returns the focus to the button.
defineOptions({ inheritAttrs: false });
const emit = defineEmits<{ catalog: [] }>();
const projects = useProjectsStore();
const chat = useChatStore();
const workspace = useWorkspaceStore();
const { owner, shown } = adminAccess();
const open = ref(false);
const trigger = useTemplateRef<{ $el: HTMLElement }>("trigger");
const loading = computed(() => !projects.loaded && !projects.error);
const name = computed(() => projects.current?.name ?? (projects.error ? "Проекты не загрузились" : "Проект не выбран"));
let next: (() => void) | null = null;

function then(action: () => void): void {
  next = action;
  open.value = false;
}

function afterClose(event: Event): void {
  const action = next;
  next = null;
  if (!action) return;
  event.preventDefault();
  trigger.value?.$el.focus();
  void nextTick(action);
}

// Another project chosen: the drawer has done its job.
watch(() => projects.currentId, () => {
  open.value = false;
});
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogTrigger ref="trigger" class="mobile-menu-trigger" v-bind="$attrs" :aria-label="`Меню. Проект: ${name}`" :aria-busy="loading || undefined">
      <Icon name="menu" class="shrink-0" />
      <template v-if="loading">
        <span class="skeleton project-emblem-skeleton size-8" aria-hidden="true" />
        <span class="skeleton h-4 w-32" aria-hidden="true" />
      </template>
      <template v-else>
        <ProjectEmblem :project="projects.current" class="size-8 rounded-lg text-sm" />
        <span class="min-w-0 truncate">{{ name }}</span>
      </template>
    </DialogTrigger>
    <DialogPortal>
      <DialogOverlay class="dialog-backdrop" />
      <DialogContent class="drawer" :aria-describedby="undefined" @close-auto-focus="afterClose">
        <header class="chrome drawer-head">
          <DialogTitle class="brand m-0 text-lg">
            <span class="brand-mark bg-white text-selection" aria-hidden="true"><Icon name="resolve" /></span>
            Resolvate
          </DialogTitle>
          <DialogClose class="quiet min-h-11 min-w-11" aria-label="Закрыть меню">
            <Icon name="close" />
          </DialogClose>
        </header>
        <div class="drawer-body">
          <section aria-labelledby="drawer-projects">
            <h2 id="drawer-projects" class="drawer-heading">Проект</h2>
            <p v-if="chat.sending" class="drawer-note">Идёт отправка: проект можно сменить после неё.</p>
            <RadioGroupRoot :model-value="projects.currentId ?? ''" orientation="vertical" loop
              aria-labelledby="drawer-projects" :disabled="chat.sending"
              @update:model-value="(id) => chooseProject(String(id), workspace.fail)">
              <RadioGroupItem
                v-for="project in projects.available"
                :key="project.id"
                :value="project.id"
                class="drawer-item"
              >
                <ProjectEmblem :project="project" class="size-8 rounded-lg text-sm" />
                <span class="min-w-0 flex-1 truncate">{{ project.name }}</span>
                <Icon v-if="project.id === projects.currentId" name="check" class="size-4 shrink-0 text-accent" />
              </RadioGroupItem>
            </RadioGroupRoot>
            <p v-if="!projects.available.length" class="drawer-note">{{ name }}</p>
          </section>
          <section v-if="shown" aria-labelledby="drawer-admin">
            <h2 id="drawer-admin" class="drawer-heading">Управление</h2>
            <button type="button" class="drawer-item" @click="then(() => workspace.openProjects())">
              <Icon name="folder" class="size-4 shrink-0" />Проекты
            </button>
            <button v-if="owner" type="button" class="drawer-item" @click="then(() => workspace.openStaff())">
              <Icon name="users" class="size-4 shrink-0" />Сотрудники
            </button>
          </section>
          <section aria-labelledby="drawer-replies">
            <h2 id="drawer-replies" class="drawer-heading">Готовые ответы</h2>
            <button type="button" class="drawer-item" :disabled="!projects.currentId" @click="then(() => emit('catalog'))">
              <Icon name="chat" class="size-4 shrink-0" />Каталог готовых ответов
            </button>
          </section>
        </div>
        <footer class="drawer-foot">
          <AccountMenu />
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
