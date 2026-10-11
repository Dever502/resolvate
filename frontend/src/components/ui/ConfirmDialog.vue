<script setup lang="ts">
import {
  AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogOverlay,
  AlertDialogPortal, AlertDialogRoot, AlertDialogTitle,
} from "reka-ui";

// Confirmation of an action that is hard to undo, on Reka AlertDialog: focus starts on the safe
// choice, a click outside does nothing, Esc cancels unless the request already runs. The window
// stays open until its owner closes it, so a failed attempt is shown here and can be repeated.
const open = defineModel<boolean>("open", { required: true });
withDefaults(defineProps<{
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** The confirmed request runs: no second request, no closing. */
  busy?: boolean;
  busyLabel?: string;
  /** The answer of a failed attempt. */
  error?: string;
  /** The confirm button is red: the action removes access, rights or data. */
  danger?: boolean;
}>(), { cancelLabel: "Отмена", busy: false, busyLabel: "Выполняем…", error: "", danger: false });
// closeAutoFocus lets the owner put focus elsewhere than back on the button that opened the window.
const emit = defineEmits<{ confirm: []; closeAutoFocus: [event: Event] }>();
</script>

<template>
  <AlertDialogRoot v-model:open="open">
    <AlertDialogPortal>
      <AlertDialogOverlay class="dialog-backdrop" />
      <AlertDialogContent
        class="dialog"
        @escape-key-down="(event: KeyboardEvent) => busy && event.preventDefault()"
        @close-auto-focus="(event: Event) => emit('closeAutoFocus', event)"
      >
        <AlertDialogTitle class="m-0 text-xl">{{ title }}</AlertDialogTitle>
        <AlertDialogDescription class="muted mt-2 mb-0 text-sm">{{ description }}</AlertDialogDescription>
        <slot />
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <div class="mt-5 flex flex-wrap items-center justify-end gap-2">
          <AlertDialogCancel class="secondary" :disabled="busy">{{ cancelLabel }}</AlertDialogCancel>
          <button type="button" :class="danger ? 'danger' : 'primary'" :aria-disabled="busy || undefined" @click="!busy && emit('confirm')">
            {{ busy ? busyLabel : confirmLabel }}
          </button>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>
