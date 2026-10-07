<script setup lang="ts">
import { nextTick, watch } from "vue";
import type { QuickReply } from "../../api/types";

// The list of quick replies above the text field. Focus never leaves the field: the field points
// at the active option (aria-activedescendant), and a click does not take focus.
const props = defineProps<{ id: string; replies: QuickReply[]; active: number }>();
const emit = defineEmits<{ choose: [index: number]; hover: [index: number] }>();

watch(() => props.active, async (index) => {
  await nextTick();
  document.getElementById(`${props.id}-${index}`)?.scrollIntoView({ block: "nearest" });
});
</script>

<template>
  <div :id="id" class="reply-options" role="listbox" aria-label="Готовые ответы">
    <div
      v-for="(reply, index) in replies"
      :id="`${id}-${index}`"
      :key="reply.id"
      class="reply-option"
      role="option"
      :aria-selected="index === active"
      @mousedown.prevent
      @click="emit('choose', index)"
      @pointermove="index !== active && emit('hover', index)"
    >
      {{ reply.text.slice(0, 240) }}
    </div>
    <p v-if="!replies.length" class="list-empty">Готовые ответы не найдены</p>
  </div>
</template>
