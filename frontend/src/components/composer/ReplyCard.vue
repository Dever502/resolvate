<script setup lang="ts">
import { computed, useTemplateRef } from "vue";
import type { QuickReply } from "../../api/types";
import ActionMenu from "../ui/ActionMenu.vue";

// One reply of the catalog: its text (long ones cut after six lines; the editor shows them whole),
// in search results also its group, and its actions in a "⋯" menu.
const props = withDefaults(defineProps<{ reply: QuickReply; group?: string; busy?: boolean }>(), { group: "", busy: false });
const emit = defineEmits<{ action: [key: "edit" | "move" | "remove"]; openGroup: [] }>();
const menu = useTemplateRef<{ focus: () => void }>("menu");
const excerpt = computed(() => {
  const flat = props.reply.text.replace(/\s+/g, " ").trim();
  return flat.length > 48 ? `${flat.slice(0, 48)}…` : flat;
});
const actions = [
  { key: "edit", label: "Изменить" },
  { key: "move", label: "Перенести" },
  { key: "remove", label: "Удалить", danger: true },
];

defineExpose({ focus: () => menu.value?.focus() });
</script>

<template>
  <article class="catalog-reply" :aria-label="`Ответ: ${excerpt}`">
    <div class="min-w-0 flex-1">
      <button v-if="group" type="button" class="catalog-reply-group" :aria-label="`Открыть группу /${group}`" @click="emit('openGroup')">/{{ group }}</button>
      <p class="catalog-reply-text">{{ reply.text }}</p>
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
