<script setup lang="ts">
import { nextTick, useTemplateRef } from "vue";
import type { QuickReply, QuickReplyGroup } from "../../api/types";
import ActionMenu from "../ui/ActionMenu.vue";
import Icon from "../ui/Icon.vue";
import ReplyCard from "./ReplyCard.vue";
import ReplyGroupEditor from "./ReplyGroupEditor.vue";

// The open group: its name with a "⋯" menu (rename, delete), "Добавить ответ" and its replies as
// cards, 50 at a time. Renaming turns the name into a field until it is saved or cancelled.
const props = withDefaults(defineProps<{
  group: QuickReplyGroup;
  replies: QuickReply[];
  more: boolean;
  loading: boolean;
  error: string;
  renaming: boolean;
  renameBusy?: boolean;
  renameError?: string;
  /** A mutation runs: actions wait. */
  busy?: boolean;
  /** A search inside this group is shown. */
  query?: string;
}>(), { renameBusy: false, renameError: "", busy: false, query: "" });
const emit = defineEmits<{
  add: [];
  action: [reply: QuickReply, key: "edit" | "move" | "remove"];
  "update:renaming": [value: boolean];
  rename: [name: string];
  removeGroup: [];
  more: [];
  retry: [];
  back: [];
}>();
const addButton = useTemplateRef<HTMLButtonElement>("add");
const groupMenu = useTemplateRef<{ focus: () => void }>("group-menu");
// By reply id: the refs of a v-for list do not follow its order.
const cards = new Map<string, { focus: () => void }>();
function bindCard(id: string, card: unknown): void {
  if (card) cards.set(id, card as { focus: () => void });
  else cards.delete(id);
}
const groupActions = [
  { key: "rename", label: "Переименовать" },
  { key: "remove", label: "Удалить группу", danger: true },
];

function cancelRename(): void {
  emit("update:renaming", false);
  void nextTick(() => groupMenu.value?.focus());
}

function groupAction(key: string): void {
  if (key === "rename") emit("update:renaming", true);
  else emit("removeGroup");
}

// The catalog puts focus back where the user was once an editor or a confirmation closes.
defineExpose({
  focusAdd: () => addButton.value?.focus(),
  focusGroupMenu: () => void nextTick(() => groupMenu.value?.focus()),
  focusReply: (id: string) => {
    const card = cards.get(id);
    if (card) card.focus();
    else addButton.value?.focus();
  },
});
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-1 flex-col" :aria-label="`Группа /${group.name}`">
    <div class="catalog-pane-head">
      <button type="button" class="quiet hidden min-w-11 narrow:-ml-2 narrow:inline-flex" aria-label="К списку групп" @click="emit('back')">
        <Icon name="back" />
      </button>
      <div v-if="renaming" class="min-w-0 flex-1 py-1">
        <ReplyGroupEditor label="Новое название группы" :initial="group.name" :busy="renameBusy" :error="renameError"
          @save="(name) => emit('rename', name)" @cancel="cancelRename" />
      </div>
      <template v-else>
        <h3 class="m-0 min-w-0 flex-1 truncate text-base" :title="`/${group.name}`">/{{ group.name }}</h3>
        <ActionMenu ref="group-menu" :label="`Действия с группой /${group.name}`" :actions="groupActions" :disabled="busy" @choose="groupAction" />
        <button ref="add" type="button" class="primary" :aria-disabled="busy || undefined" @click="!busy && emit('add')">
          <Icon name="plus" class="size-4" />
          Добавить ответ
        </button>
      </template>
    </div>
    <div class="catalog-scroll p-3">
      <p v-if="error" class="error m-1" role="alert">
        {{ error }}
        <button type="button" class="quiet ml-1" @click="emit('retry')">Повторить</button>
      </p>
      <p v-else-if="loading && !replies.length" class="muted m-1" role="status">Загружаем ответы…</p>
      <div v-else-if="!replies.length" class="catalog-empty">
        <p class="m-0">{{ query ? `В /${group.name} ничего не найдено по запросу «${query}».` : "В группе пока нет ответов." }}</p>
      </div>
      <ul v-else class="m-0 grid list-none gap-2.5 p-0" :aria-label="`Ответы группы /${group.name}`">
        <li v-for="reply in replies" :key="reply.id">
          <ReplyCard :ref="(card) => bindCard(reply.id, card)" :reply="reply" :busy="busy" @action="(key) => emit('action', reply, key)" />
        </li>
      </ul>
      <button v-if="more && !error" type="button" class="quiet mx-auto mt-3 flex" :aria-disabled="loading || undefined"
        @click="!loading && emit('more')">{{ loading ? "Загружаем…" : "Ещё ответы" }}</button>
    </div>
  </section>
</template>
