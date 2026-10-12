<script setup lang="ts">
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from "reka-ui";
import { nextTick, useTemplateRef } from "vue";
import Icon from "./Icon.vue";

export interface Action {
  key: string;
  label: string;
  danger?: boolean;
}

// The "⋯" menu of one item (a group, a reply). The chosen action runs only after the menu has
// closed and focus is back on its button: Reka returns it after a timeout, and a window or a
// screen opened earlier would remember the vanishing menu item and lose focus when it closes.
const props = withDefaults(defineProps<{ label: string; actions: Action[]; disabled?: boolean }>(), { disabled: false });
const emit = defineEmits<{ choose: [key: string] }>();
const trigger = useTemplateRef<{ $el: HTMLElement }>("trigger");
let chosen: string | null = null;

function choose(key: string): void {
  chosen = key;
}

function afterClose(event: Event): void {
  const key = chosen;
  chosen = null;
  if (!key) return;
  event.preventDefault();
  trigger.value?.$el.focus();
  void nextTick(() => emit("choose", key));
}

defineExpose({ focus: () => trigger.value?.$el.focus() });
</script>

<template>
  <div class="shrink-0">
    <DropdownMenuRoot :modal="false">
      <DropdownMenuTrigger ref="trigger" class="quiet min-w-9 px-2" :aria-label="props.label" :disabled="disabled">
        <Icon name="more" />
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent class="menu" align="end" :side-offset="4" :collision-padding="8" loop @close-auto-focus="afterClose">
          <DropdownMenuItem
            v-for="action in actions"
            :key="action.key"
            class="menu-item"
            :class="{ 'text-danger': action.danger }"
            @select="choose(action.key)"
          >
            {{ action.label }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
  </div>
</template>
