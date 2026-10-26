<script setup lang="ts">
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";
import { computed, provide, ref } from "vue";
import { WINDOW_REQUESTS } from "../../composables/useRequest";
import Icon from "./Icon.vue";

// A modal window on Reka UI: focus is trapped, Esc closes the top window only, focus returns to
// what opened it. As with the classic <dialog>, a click outside the window does not close it.
const open = defineModel<boolean>("open", { required: true });
const props = withDefaults(defineProps<{
  title: string;
  description?: string;
  closeLabel?: string;
  /** Esc and the close button do nothing (for example while the window's request runs). */
  locked?: boolean;
  wide?: boolean;
  /** A size and layout of one window's own (the quick replies catalog), without changing the others. */
  contentClass?: string;
}>(), { description: "", closeLabel: "Закрыть", locked: false, wide: false, contentClass: "" });
const emit = defineEmits<{ openAutoFocus: [event: Event] }>();
// Changes sent from inside the window (composables/useRequest) lock it too until they answer.
const requests = ref(0);
provide(WINDOW_REQUESTS, requests);
const blocked = computed(() => props.locked || requests.value > 0);
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="dialog-backdrop" />
      <DialogContent
        class="dialog"
        :class="[{ 'dialog-wide': wide }, contentClass]"
        v-bind="description ? {} : { 'aria-describedby': undefined }"
        @pointer-down-outside="(event: Event) => event.preventDefault()"
        @escape-key-down="(event: KeyboardEvent) => blocked && event.preventDefault()"
        @open-auto-focus="(event: Event) => emit('openAutoFocus', event)"
      >
        <header class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <DialogTitle class="m-0 text-xl text-balance [overflow-wrap:anywhere]">{{ title }}</DialogTitle>
            <DialogDescription v-if="description" class="muted mt-2 mb-0 text-sm text-pretty">{{ description }}</DialogDescription>
          </div>
          <!-- A 44×44 hit area that takes no more room than the 38×36 button of the icon: the negative margins
               keep the title's width and the header's height, the extra reaches into the window's padding. -->
          <DialogClose class="quiet -my-1 -mr-1.5 min-h-11 min-w-11 shrink-0" :aria-label="closeLabel" :disabled="blocked">
            <Icon name="close" />
          </DialogClose>
        </header>
        <slot />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
