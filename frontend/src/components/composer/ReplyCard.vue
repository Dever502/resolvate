<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, useTemplateRef, watch } from "vue";
import type { QuickReply } from "../../api/types";
import ActionMenu from "../ui/ActionMenu.vue";
import Icon from "../ui/Icon.vue";

// One reply of the catalog: its text, in search results also its group, and its actions in a "⋯"
// menu. A long text shows six lines and opens in place with "Показать полностью": reading a reply
// does not need its editor.
const LINES = 6;
const props = withDefaults(defineProps<{ reply: QuickReply; group?: string; busy?: boolean }>(), { group: "", busy: false });
const emit = defineEmits<{ action: [key: "edit" | "move" | "remove"]; openGroup: [] }>();
const id = useId();
const menu = useTemplateRef<{ focus: () => void }>("menu");
const card = useTemplateRef<HTMLElement>("card");
const body = useTemplateRef<HTMLElement>("text");
const expanded = ref(false);
/** The text takes more than six lines at the card's current width and font. */
const long = ref(false);
let observer: ResizeObserver | null = null;
const excerpt = computed(() => {
  const flat = props.reply.text.replace(/\s+/g, " ").trim();
  return flat.length > 48 ? `${flat.slice(0, 48)}…` : flat;
});
const actions = [
  { key: "edit", label: "Изменить" },
  { key: "move", label: "Перенести" },
  { key: "remove", label: "Удалить", danger: true },
];

// What counts is the rendered text, not its length: scrollHeight is the full height of the text
// whether it is clamped or not, compared with six lines of its line height. The text box has no
// padding; a pixel of rounding is allowed.
function measure(): void {
  const element = body.value;
  if (!element) return;
  const line = parseFloat(getComputedStyle(element).lineHeight);
  long.value = Number.isFinite(line) && element.scrollHeight > line * LINES + 1;
}

// Collapsing a tall card shortens the list above the reader: its top is brought back into view.
function keepInView(): void {
  const element = card.value;
  const scroller = element?.closest<HTMLElement>(".catalog-scroll");
  if (!element || !scroller) return;
  const above = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  if (above < 0) scroller.scrollTop += above - 8;
}

function toggle(): void {
  expanded.value = !expanded.value;
  if (!expanded.value) void nextTick(keepInView);
}

// The width, the font size or the zoom change the lines: the observer measures again then, and only then.
onMounted(() => {
  measure();
  if (typeof ResizeObserver === "undefined" || !body.value) return;
  observer = new ResizeObserver(measure);
  observer.observe(body.value);
});
onBeforeUnmount(() => observer?.disconnect());

// Another text (saved by someone) starts collapsed and is measured anew.
watch(() => props.reply.text, () => {
  expanded.value = false;
  void nextTick(measure);
});

defineExpose({ focus: () => menu.value?.focus() });
</script>

<template>
  <article ref="card" class="catalog-reply" :aria-label="`Ответ: ${excerpt}`">
    <div class="min-w-0 flex-1">
      <button v-if="group" type="button" class="catalog-reply-group" :aria-label="`Открыть группу #${group}`" @click="emit('openGroup')">#{{ group }}</button>
      <p :id="`${id}-text`" ref="text" class="catalog-reply-text" :data-expanded="expanded || undefined">{{ reply.text }}</p>
      <div v-if="long" class="catalog-reply-more">
        <button type="button" class="quiet catalog-reply-toggle" :aria-expanded="expanded" :aria-controls="`${id}-text`" @click="toggle">
          <template v-if="expanded">Свернуть<span class="sr-only"> ответ</span></template>
          <template v-else>Показать<span class="sr-only"> ответ</span> полностью</template>
          <Icon name="chevron" class="size-4 shrink-0" :class="{ 'rotate-180': expanded }" />
        </button>
      </div>
    </div>
    <ActionMenu
      ref="menu"
      :label="`Действия с ответом «${excerpt}»`"
      :actions="actions"
      :disabled="busy"
      @choose="(key) => emit('action', key as 'edit' | 'move' | 'remove')"
    />
  </article>
</template>
