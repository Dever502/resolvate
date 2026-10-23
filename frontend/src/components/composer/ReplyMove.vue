<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId, useTemplateRef } from "vue";
import type { QuickReply, QuickReplyGroup } from "../../api/types";
import Icon from "../ui/Icon.vue";

// Moving one reply to another group: the reply, a searchable choice of the target group (the
// server's group search, 50 at a time) and "Перенести"/"Отмена". Cancelling returns to the reply's
// own group; nothing changes until "Перенести".
const props = withDefaults(defineProps<{
  reply: QuickReply;
  from: QuickReplyGroup;
  load: (query: string, offset: number, signal: AbortSignal) => Promise<QuickReplyGroup[]>;
  busy?: boolean;
  error?: string;
}>(), { busy: false, error: "" });
const emit = defineEmits<{ move: [target: QuickReplyGroup]; cancel: [] }>();
const id = useId();
const search = useTemplateRef<HTMLInputElement>("search");
const query = ref("");
const groups = ref<QuickReplyGroup[]>([]);
const more = ref(false);
const loading = ref(false);
const loadError = ref("");
const target = ref<QuickReplyGroup | null>(null);
const problem = ref("");
let controller: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

async function fetchGroups(append = false): Promise<void> {
  controller?.abort();
  const own = new AbortController();
  controller = own;
  loading.value = true;
  loadError.value = "";
  try {
    const rows = await props.load(query.value.trim(), append ? groups.value.length : 0, own.signal);
    if (own.signal.aborted) return;
    groups.value = append ? [...groups.value, ...rows] : rows;
    more.value = rows.length === 50;
  } catch (error) {
    if (!own.signal.aborted) loadError.value = error instanceof Error ? error.message : "Не удалось загрузить группы.";
  } finally {
    if (controller === own) {
      controller = null;
      loading.value = false;
    }
  }
}

function typed(): void {
  clearTimeout(timer);
  timer = setTimeout(() => void fetchGroups(), 250);
}

// Enter in the search looks for groups at once; it never sends the move.
function searchNow(): void {
  clearTimeout(timer);
  void fetchGroups();
}

function move(): void {
  if (props.busy) return;
  problem.value = target.value ? "" : "Выберите группу, куда перенести ответ.";
  if (target.value) emit("move", target.value);
}

onMounted(() => {
  void fetchGroups();
  search.value?.focus();
});
onBeforeUnmount(() => {
  clearTimeout(timer);
  controller?.abort();
});
</script>

<template>
  <form class="flex min-h-0 flex-1 flex-col" novalidate @submit.prevent="move">
    <div class="catalog-pane-head">
      <!-- A 44×44 hit area in the 44×36 room the head has for it. -->
      <button type="button" class="quiet -my-1 min-h-11 min-w-11 narrow:-ml-2" :aria-disabled="busy || undefined"
        :aria-label="`Назад к #${from.name}`" @click="!busy && emit('cancel')"><Icon name="back" /></button>
      <h3 class="m-0 min-w-0 flex-1 truncate text-base">Перенос ответа из #{{ from.name }}</h3>
    </div>
    <div class="catalog-scroll grid content-start gap-3 p-4">
      <p class="catalog-version catalog-version-clamp">{{ reply.text }}</p>
      <div class="catalog-search">
        <Icon name="search" />
        <input
          ref="search"
          v-model="query"
          type="search"
          maxlength="100"
          placeholder="Найти группу…"
          aria-label="Найти группу для переноса"
          @input="typed"
          @keydown.enter.prevent="searchNow"
        />
      </div>
      <fieldset class="choice-field" :aria-describedby="problem || error ? `${id}-error` : undefined">
        <legend class="field-label">Куда перенести</legend>
        <p v-if="loadError" class="error m-0" role="alert">
          {{ loadError }}
          <button type="button" class="quiet ml-1" @click="fetchGroups()">Повторить</button>
        </p>
        <p v-else-if="loading && !groups.length" class="muted m-0" role="status">Загружаем группы…</p>
        <template v-else>
          <div v-for="group in groups.filter((item) => item.id !== from.id)" :key="group.id" class="toggle-field">
            <input :id="`${id}-${group.id}`" type="radio" :name="id" :value="group.id" :checked="target?.id === group.id"
              @change="target = group; problem = ''" />
            <label :for="`${id}-${group.id}`" class="min-w-0 [overflow-wrap:anywhere]">#{{ group.name }}</label>
          </div>
          <p v-if="!groups.some((item) => item.id !== from.id)" class="muted m-0">
            {{ query.trim() ? "Таких групп нет." : "Других групп нет: сначала создайте группу." }}
          </p>
          <button v-if="more" type="button" class="quiet justify-self-start" :aria-disabled="loading || undefined"
            @click="!loading && fetchGroups(true)">Ещё группы</button>
        </template>
      </fieldset>
      <p v-if="problem || error" :id="`${id}-error`" class="field-error m-0" role="alert">{{ problem || error }}</p>
    </div>
    <div class="flex flex-wrap justify-end gap-2 border-t border-border px-4 py-3">
      <button type="button" class="quiet" :aria-disabled="busy || undefined" @click="!busy && emit('cancel')">Отмена</button>
      <button type="submit" class="primary" :aria-disabled="busy || undefined">
        {{ busy ? "Переносим…" : target ? `Перенести в #${target.name}` : "Перенести" }}
      </button>
    </div>
  </form>
</template>
