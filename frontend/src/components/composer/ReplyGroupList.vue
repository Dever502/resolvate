<script setup lang="ts">
import { ListboxContent, ListboxItem, ListboxRoot } from "reka-ui";
import { nextTick, useTemplateRef } from "vue";
import type { QuickReplyGroup } from "../../api/types";
import Icon from "../ui/Icon.vue";
import ReplyGroupEditor from "./ReplyGroupEditor.vue";

// The groups column: the catalog's groups as one keyboard stop (arrows, Home/End, typing; Enter
// opens one), the open one marked, "Новая группа" with a compact name field, and pages of 50.
const props = withDefaults(defineProps<{
  groups: QuickReplyGroup[];
  selected: string | null;
  more: boolean;
  loading: boolean;
  error: string;
  creating: boolean;
  createBusy?: boolean;
  createError?: string;
}>(), { createBusy: false, createError: "" });
const emit = defineEmits<{
  select: [group: QuickReplyGroup];
  more: [];
  retry: [];
  "update:creating": [value: boolean];
  create: [name: string];
}>();

function choose(value: unknown): void {
  const group = props.groups.find((item) => item.id === value);
  if (group) emit("select", group);
}

const root = useTemplateRef<HTMLElement>("root");
const newGroup = useTemplateRef<HTMLButtonElement>("new-group");
const listbox = useTemplateRef<{ highlightSelected: () => Promise<void> }>("listbox");

// A cancelled name field gives focus back to the button that opened it.
function cancelCreate(): void {
  emit("update:creating", false);
  void nextTick(() => newGroup.value?.focus());
}
// Focus goes to the open group, else the first one, else "Новая группа". The listbox moves it itself:
// a plain DOM focus would leave Reka's highlight behind, and the arrows would start from the top.
defineExpose({
  focus: () => {
    if (listbox.value) void listbox.value.highlightSelected();
    else root.value?.querySelector<HTMLElement>(".catalog-pane-head button")?.focus();
  },
});
</script>

<template>
  <nav ref="root" class="catalog-groups" aria-label="Группы ответов">
    <div class="catalog-pane-head justify-between">
      <h3 class="m-0 text-base">Группы</h3>
      <button v-if="!creating" ref="new-group" type="button" class="quiet" @click="emit('update:creating', true)">
        <Icon name="plus" class="size-4" />
        Новая группа
      </button>
    </div>
    <div v-if="creating" class="border-b border-border p-3">
      <ReplyGroupEditor label="Новая группа" :busy="createBusy" :error="createError"
        @save="(name) => emit('create', name)" @cancel="cancelCreate" />
    </div>
    <div class="catalog-scroll p-2">
      <p v-if="error" class="error m-2" role="alert">
        {{ error }}
        <button type="button" class="quiet ml-1" @click="emit('retry')">Повторить</button>
      </p>
      <p v-else-if="loading && !groups.length" class="muted m-2" role="status">Загружаем группы…</p>
      <p v-else-if="!groups.length" class="muted m-2">
        Групп пока нет. Создайте первую группу, чтобы добавить в неё ответы.
      </p>
      <ListboxRoot
        v-if="groups.length"
        ref="listbox"
        :model-value="selected ?? ''"
        selection-behavior="replace"
        @update:model-value="choose"
      >
        <ListboxContent class="grid gap-0.5 outline-none" aria-label="Группы">
          <ListboxItem
            v-for="group in groups"
            :key="group.id"
            :value="group.id"
            :data-revision="`${group.revision}:${group.name}`"
            class="catalog-group"
            :title="`#${group.name}`"
          >
            #{{ group.name }}
          </ListboxItem>
        </ListboxContent>
      </ListboxRoot>
      <button v-if="more && !error" type="button" class="quiet mx-auto mt-2 flex" :aria-disabled="loading || undefined"
        @click="!loading && emit('more')">{{ loading ? "Загружаем…" : "Ещё группы" }}</button>
    </div>
  </nav>
</template>
