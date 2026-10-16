<script setup lang="ts">
import { nextTick, ref, useTemplateRef, watch } from "vue";

// The quick replies picker above the text field, the same however it was opened ("/" typed into an
// empty reply box, or the button): its own search field holds the focus and points at the active
// option (aria-activedescendant); a click on an option does not take the focus. Esc closes the list
// from anywhere in it; a failed lookup is said with a retry, not as "nothing found". The header and
// the search stay, the results scroll: once they are scrolled, their top edge fades out instead of
// running up to the search field.
const props = defineProps<{
  id: string; replies: { id: string; text: string }[]; active: number;
  group: string; loading: boolean; failed: boolean; more: boolean; query: string;
}>();
const emit = defineEmits<{
  choose: [index: number]; hover: [index: number]; back: []; more: []; close: []; retry: [];
  search: [value: string]; keydown: [event: KeyboardEvent];
}>();
const field = useTemplateRef<HTMLInputElement>("field");
const body = useTemplateRef<HTMLElement>("body");
/** The results are scrolled away from their start: the fade at their top edge is shown. */
const scrolled = ref(false);
let pointerSelection: number | undefined;

function hover(index: number): void {
  if (index === props.active) return;
  pointerSelection = index;
  emit("hover", index);
}

function onScroll(): void {
  scrolled.value = (body.value?.scrollTop ?? 0) > 0;
}

// New results (another search or group) start at the top; the browser may not report that as a scroll.
watch(() => props.replies, async () => {
  await nextTick();
  onScroll();
});

// The active option comes fully into view: the body's scroll padding keeps it clear of the fade.
watch(() => props.active, async (index) => {
  const fromPointer = pointerSelection === index;
  pointerSelection = undefined;
  // Wheel scrolling moves options under the pointer. Scrolling that hovered
  // option back into view can cancel the browser's ongoing wheel scroll.
  if (fromPointer) return;
  await nextTick();
  document.getElementById(`${props.id}-${index}`)?.scrollIntoView({ block: "nearest" });
});

defineExpose({ focusSearch: () => field.value?.focus() });
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
      ref="field"
      :value="query"
      class="reply-search"
      role="combobox"
      aria-label="Поиск готовых ответов"
      aria-autocomplete="list"
      aria-expanded="true"
      :aria-controls="id"
      :aria-activedescendant="replies.length ? `${id}-${active}` : undefined"
      :placeholder="group ? 'Найти ответ…' : 'Найти группу…'"
      maxlength="100"
      @input="emit('search', ($event.target as HTMLInputElement).value)"
      @keydown="emit('keydown', $event)"
    />
    <div ref="body" class="reply-options-body" :data-scrolled="scrolled || undefined" @scroll.passive="onScroll">
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
          @pointermove="hover(index)"
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
