<script lang="ts">
import { computed } from "vue";
import { useProjectsStore } from "../../stores/projects";
import { useSessionStore } from "../../stores/session";

/**
 * What the account may administer (the app bar's menu, the narrow screens' drawer): "Проекты" for the
 * installation administrator and project administrators (`shown`), "Сотрудники" for the installation
 * administrator only (`owner`). Hiding is a convenience: the server checks every request.
 */
export function adminAccess() {
  const session = useSessionStore();
  const projects = useProjectsStore();
  const owner = computed(() => session.account?.role === "admin");
  const shown = computed(() => owner.value || projects.all.some((project) => project.role === "admin"));
  return { owner, shown };
}
</script>

<script setup lang="ts">
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from "reka-ui";
import { nextTick, useTemplateRef } from "vue";
import { useWorkspaceStore } from "../../stores/workspace";
import Icon from "../ui/Icon.vue";

// Administration in the app bar, apart from everyday work and from the personal account menu:
// "Проекты" for the installation administrator and project administrators, "Сотрудники" for the
// installation administrator only. Hiding is a convenience: the server checks every request.
// Narrow screens have the same actions in the app bar's drawer (MobileMenu.vue) instead.
const workspace = useWorkspaceStore();
const { owner, shown } = adminAccess();
const trigger = useTemplateRef<{ $el: HTMLElement }>("trigger");
let chosen: (() => void) | null = null;

function choose(open: () => void): void {
  chosen = open;
}

// The window opens after the menu has closed and the trigger has focus again, so closing the
// window returns focus to the trigger (Reka itself refocuses it only after a timeout).
function afterClose(event: Event): void {
  const open = chosen;
  chosen = null;
  if (!open) return;
  event.preventDefault();
  trigger.value?.$el.focus();
  void nextTick(open);
}
</script>

<template>
  <div v-if="shown">
    <DropdownMenuRoot :modal="false">
      <!-- At least 44×44; the negative margins keep the bar's height. -->
      <DropdownMenuTrigger ref="trigger" class="quiet admin-trigger -my-1 min-h-11 min-w-11">
        <Icon name="settings" />
        <span>Управление</span>
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent class="menu" align="end" :side-offset="6" :collision-padding="8" loop @close-auto-focus="afterClose">
          <DropdownMenuItem class="menu-item" @select="choose(workspace.openProjects)">
            <Icon name="folder" class="size-4" />
            Проекты
          </DropdownMenuItem>
          <DropdownMenuItem v-if="owner" class="menu-item" @select="choose(workspace.openStaff)">
            <Icon name="users" class="size-4" />
            Сотрудники
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
  </div>
</template>
