<script setup lang="ts">
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";
import Icon from "./Icon.vue";

// A modal window on Reka UI: focus is trapped, Esc closes the top window only, focus returns to
// what opened it. As with the classic <dialog>, a click outside the window does not close it.
const open = defineModel<boolean>("open", { required: true });
withDefaults(defineProps<{
  title: string;
  description?: string;
  closeLabel?: string;
  /** Esc and the close button do nothing (for example while the window's request runs). */
  locked?: boolean;
  wide?: boolean;
}>(), { description: "", closeLabel: "Закрыть", locked: false, wide: false });
const emit = defineEmits<{ openAutoFocus: [event: Event] }>();
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="dialog-backdrop" />
      <DialogContent
        class="dialog"
        :class="{ 'dialog-wide': wide }"
        v-bind="description ? {} : { 'aria-describedby': undefined }"
        @pointer-down-outside="(event: Event) => event.preventDefault()"
        @escape-key-down="(event: KeyboardEvent) => locked && event.preventDefault()"
        @open-auto-focus="(event: Event) => emit('openAutoFocus', event)"
      >
        <header class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <DialogTitle class="m-0 text-xl">{{ title }}</DialogTitle>
            <DialogDescription v-if="description" class="muted mt-2 mb-0 text-sm">{{ description }}</DialogDescription>
          </div>
          <DialogClose class="quiet min-w-9 shrink-0" :aria-label="closeLabel" :disabled="locked">
            <Icon name="close" />
          </DialogClose>
        </header>
        <slot />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
