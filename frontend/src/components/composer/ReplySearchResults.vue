<script setup lang="ts">
import type { QuickReply, QuickReplyGroup } from "../../api/types";
import ReplyCard from "./ReplyCard.vue";

// Results of a search across the catalog: the groups whose name matches and the replies whose
// text does, each reply with its group (a link back to that group). 50 of each at a time.
const props = defineProps<{
  query: string;
  groups: QuickReplyGroup[];
  replies: QuickReply[];
  /** Group names by id; a name not known yet shows as "…". */
  names: Map<string, string>;
  moreGroups: boolean;
  moreReplies: boolean;
  loading: boolean;
  error: string;
  busy: boolean;
}>();
const emit = defineEmits<{
  openGroup: [id: string];
  action: [reply: QuickReply, key: "edit" | "move" | "remove"];
  moreGroups: [];
  moreReplies: [];
  retry: [];
}>();
const cards = new Map<string, { focus: () => void }>();
function bindCard(id: string, card: unknown): void {
  if (card) cards.set(id, card as { focus: () => void });
  else cards.delete(id);
}

// Whether the reply is still among the results: if not, the catalog puts focus elsewhere.
defineExpose({
  focusReply: (id: string): boolean => {
    cards.get(id)?.focus();
    return cards.has(id);
  },
});
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Результаты поиска">
    <div class="catalog-pane-head">
      <h3 class="m-0 min-w-0 flex-1 truncate text-base">Поиск: «{{ query }}»</h3>
    </div>
    <div class="catalog-scroll grid content-start gap-5 p-3">
      <p v-if="error" class="error m-1" role="alert">
        {{ error }}
        <button type="button" class="quiet ml-1" @click="emit('retry')">Повторить</button>
      </p>
      <p v-else-if="loading && !groups.length && !replies.length" class="muted m-1" role="status">Ищем…</p>
      <div v-else-if="!groups.length && !replies.length" class="catalog-empty">
        <p class="m-0">Ничего не найдено по запросу «{{ query }}». Измените запрос или очистите поиск.</p>
      </div>
      <section v-if="groups.length" aria-labelledby="catalog-found-groups">
        <h4 id="catalog-found-groups" class="muted small m-0 mb-1.5 font-semibold">Группы</h4>
        <ul class="m-0 flex list-none flex-wrap gap-1.5 p-0">
          <li v-for="group in groups" :key="group.id" class="max-w-full">
            <button type="button" class="secondary max-w-full truncate" @click="emit('openGroup', group.id)">#{{ group.name }}</button>
          </li>
        </ul>
        <button v-if="moreGroups" type="button" class="quiet mt-1" :aria-disabled="loading || undefined"
          @click="!loading && emit('moreGroups')">Ещё группы</button>
      </section>
      <section v-if="replies.length" aria-labelledby="catalog-found-replies">
        <h4 id="catalog-found-replies" class="muted small m-0 mb-1.5 font-semibold">Ответы</h4>
        <ul class="m-0 grid list-none gap-2.5 p-0">
          <li v-for="reply in replies" :key="reply.id">
            <ReplyCard
              :ref="(card) => bindCard(reply.id, card)"
              :reply="reply"
              :group="props.names.get(reply.group_id) ?? '…'"
              :busy="busy"
              @open-group="emit('openGroup', reply.group_id)"
              @action="(key) => emit('action', reply, key)"
            />
          </li>
        </ul>
        <button v-if="moreReplies" type="button" class="quiet mx-auto mt-3 flex" :aria-disabled="loading || undefined"
          @click="!loading && emit('moreReplies')">Ещё ответы</button>
      </section>
    </div>
  </section>
</template>
