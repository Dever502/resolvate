<script setup lang="ts">
import { nextTick, watch } from "vue";

// The list of quick replies above the text field. The field that has the focus points at the active
// option (aria-activedescendant): the reply box when "/" was typed in it, the list's own search field
// when the "/" button opened it. A click does not take the focus. Esc closes the list from anywhere in
// it; a failed lookup is said with a retry, not as "nothing found". The header and the search stay,
// the results scroll.
const props = defineProps<{
  id: string; replies: { id: string; text: string }[]; active: number;
  group: string; loading: boolean; failed: boolean; more: boolean; query: string; buttonMode: boolean;
}>();
const emit = defineEmits<{
  choose: [index: number]; hover: [index: number]; back: []; more: []; close: []; retry: [];
  search: [value: string]; keydown: [event: KeyboardEvent];
}>();

watch(() => props.active, async (index) => {
  await nextTick();
  document.getElementById(`${props.id}-${index}`)?.scrollIntoView({ block: "nearest" });
});
</script>

<template>
  <div class="reply-options" @keydown.esc.prevent.stop="emit('close')">
    <!-- 44 px tall buttons. The close button's 44×44 takes the head's end padding and the gap before it, so the
         title gives up less than 2 px of its room. -->
    <div class="reply-options-head">
      <button v-if="group" class="quiet min-h-11" type="button" @mousedown.prevent @click="emit('back')">← Группы</button>
      <span class="min-w-0 flex-1 truncate">{{ group ? '/' + group : 'Группы ответов' }}</span>
      <button class="quiet -ml-2 min-h-11 min-w-11" type="button" aria-label="Закрыть готовые ответы" @click="emit('close')">×</button>
    </div>
    <input
      v-if="buttonMode"
      :value="query"
      class="reply-search"
      role="combobox"
      aria-label="Поиск готовых ответов"
      aria-autocomplete="list"
      aria-expanded="true"
      :aria-controls="id"
      :aria-activedescendant="replies.length ? `${id}-${active}` : undefined"
      placeholder="Найти…"
      maxlength="100"
      @input="emit('search', ($event.target as HTMLInputElement).value)"
      @keydown="emit('keydown', $event)"
    />
    <div class="reply-options-body">
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
      </div>
      <p v-if="failed" class="reply-options-error" role="alert">
        Не удалось загрузить готовые ответы.
        <button class="quiet" type="button" @mousedown.prevent @click="emit('retry')">Повторить</button>
      </p>
      <p v-else-if="!loading && !replies.length" class="list-empty">Ничего не найдено</p>
      <button v-if="more" class="quiet w-full" type="button" :disabled="loading" @click="emit('more')">Показать ещё</button>
    </div>
  </div>
</template>
