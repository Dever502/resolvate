<script setup lang="ts">
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from "reka-ui";
import { computed, nextTick, useTemplateRef } from "vue";
import { useProjectsStore } from "../../stores/projects";
import { useSessionStore } from "../../stores/session";
import { useWorkspaceStore } from "../../stores/workspace";
import Icon from "../ui/Icon.vue";

// Administration in the app bar, apart from everyday work and from the personal account menu:
// "Проекты" for the installation administrator and project administrators, "Сотрудники" for the
// installation administrator only. Hiding is a convenience: the server checks every request.
// On narrow screens only the icon remains; its label shows on hover and keyboard focus. That label
// is a plain hidden element, not a Reka tooltip: in reka-ui 2.11.0 a tooltip trigger around (or
// inside) a menu trigger loses the element the menu is positioned against.
const session = useSessionStore();
const projects = useProjectsStore();
const workspace = useWorkspaceStore();
const owner = computed(() => session.account?.role === "admin");
const shown = computed(() => owner.value || projects.all.some((project) => project.role === "admin"));
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
      <!-- At least 44×44 (on narrow screens it is the icon alone); the negative margins keep the bar's height. -->
      <DropdownMenuTrigger ref="trigger" class="quiet admin-trigger -my-1 min-h-11 min-w-11">
        <Icon name="settings" />
        <span class="narrow:sr-only">Управление</span>
        <span class="admin-trigger-label" aria-hidden="true">Управление</span>
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
