<script setup lang="ts">
import { nextTick, watch } from "vue";

// The list of quick replies above the text field. Focus never leaves the field: the field points
// at the active option (aria-activedescendant), and a click does not take focus.
const props = defineProps<{
  id: string; replies: { id: string; text: string }[]; active: number;
  group: string; loading: boolean; more: boolean; query: string; buttonMode: boolean;
}>();
const emit = defineEmits<{
  choose: [index: number]; hover: [index: number]; back: []; more: []; close: [];
  search: [value: string]; keydown: [event: KeyboardEvent];
}>();

watch(() => props.active, async (index) => {
  await nextTick();
  document.getElementById(`${props.id}-${index}`)?.scrollIntoView({ block: "nearest" });
});
</script>

<template>
  <div class="reply-options">
    <div class="flex items-center gap-2 border-b border-border p-2">
      <button v-if="group" class="quiet" type="button" @mousedown.prevent @click="emit('back')">← Группы</button>
      <span class="min-w-0 flex-1 truncate">{{ group ? '/' + group : 'Группы ответов' }}</span>
      <button class="quiet" type="button" aria-label="Закрыть готовые ответы" @click="emit('close')">×</button>
    </div>
    <input v-if="buttonMode" :value="query" aria-label="Поиск готовых ответов" placeholder="Найти…"
      maxlength="100" class="w-full" @input="emit('search', ($event.target as HTMLInputElement).value)"
      @keydown="emit('keydown', $event)" />
    <p v-if="loading" class="muted p-2" role="status">Загрузка…</p>
    <div :id="id" role="listbox" :aria-label="group ? 'Готовые ответы' : 'Группы ответов'" :aria-busy="loading">
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
    <p v-if="!loading && !replies.length" class="list-empty">Ничего не найдено</p>
    </div>
    <button v-if="more" class="quiet w-full" type="button" :disabled="loading" @click="emit('more')">Показать ещё</button>
  </div>
</template>
