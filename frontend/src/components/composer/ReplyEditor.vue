<script setup lang="ts">
import { computed, onMounted, ref, useId, useTemplateRef, watch } from "vue";
import Icon from "../ui/Icon.vue";

// Creating or changing one reply: a real multi-line field (Enter starts a new line), "Сохранить"
// and "Отмена". When another operator changed the reply meanwhile, their version is shown next to
// the draft: nothing is overwritten without an explicit save, and the draft is never lost.
const MAX_REPLY = 3900;
const props = withDefaults(defineProps<{
  mode: "create" | "edit";
  group: string;
  initial?: string;
  busy?: boolean;
  error?: string;
  /** The server's current text after a revision conflict; null when there is none. */
  current?: string | null;
}>(), { initial: "", busy: false, error: "", current: null });
const dirty = defineModel<boolean>("dirty", { required: true });
const emit = defineEmits<{ save: [text: string]; cancel: [] }>();
const id = useId();
const field = useTemplateRef<HTMLTextAreaElement>("field");
const text = ref(props.initial);
const problem = ref("");
// The server counts UTF-16 units, so an emoji may take two.
const length = computed(() => text.value.length);

watch(text, (value) => {
  dirty.value = value !== props.initial;
  problem.value = "";
}, { immediate: true });

onMounted(() => {
  field.value?.focus();
  // The caret goes to the end of an existing reply, not before its first letter.
  field.value?.setSelectionRange(text.value.length, text.value.length);
});

function save(): void {
  if (props.busy) return;
  problem.value = !text.value.trim() ? "Введите текст ответа."
    : length.value > MAX_REPLY ? `Не больше ${MAX_REPLY} символов.` : "";
  if (problem.value) {
    field.value?.focus();
    return;
  }
  emit("save", text.value);
}

function takeCurrent(): void {
  if (props.current === null) return;
  text.value = props.current;
  field.value?.focus();
}
</script>

<template>
  <form class="flex min-h-0 flex-1 flex-col" novalidate :aria-busy="busy || undefined" @submit.prevent="save">
    <div class="catalog-pane-head">
      <button type="button" class="quiet min-w-11 narrow:-ml-2" :aria-disabled="busy || undefined"
        aria-label="Назад к ответам группы" @click="!busy && emit('cancel')"><Icon name="back" /></button>
      <h3 class="m-0 min-w-0 flex-1 truncate text-base">{{ mode === "create" ? `Новый ответ в /${group}` : `Изменение ответа в /${group}` }}</h3>
    </div>
    <div class="catalog-scroll grid content-start gap-3 p-4">
      <div v-if="current !== null" class="grid gap-2" role="group" aria-label="Версия другого оператора">
        <p class="error m-0" role="alert">
          Пока вы редактировали, ответ изменил другой оператор. Его версия ниже, ваш черновик остался в поле.
          «Сохранить ответ» заменит его версию вашей.
        </p>
        <p class="catalog-version catalog-version-clamp">{{ current }}</p>
        <div><button type="button" class="secondary" :aria-disabled="busy || undefined" @click="!busy && takeCurrent()">Взять эту версию в поле</button></div>
      </div>
      <label :for="id" class="field-label mb-0">Текст готового ответа</label>
      <textarea
        :id="id"
        ref="field"
        v-model="text"
        class="catalog-textarea"
        rows="9"
        :aria-invalid="problem ? 'true' : undefined"
        :aria-describedby="`${id}-count${problem || error ? ` ${id}-error` : ''}`"
      />
      <div class="flex flex-wrap items-start justify-between gap-2">
        <p :id="`${id}-count`" class="muted small m-0">{{ length }} / {{ MAX_REPLY }} символов; эмодзи может занимать два</p>
        <p v-if="problem || error" :id="`${id}-error`" class="field-error m-0" role="alert">{{ problem || error }}</p>
      </div>
    </div>
    <div class="flex flex-wrap justify-end gap-2 border-t border-border px-4 py-3">
      <button type="button" class="quiet" :aria-disabled="busy || undefined" @click="!busy && emit('cancel')">Отмена</button>
      <button type="submit" class="primary" :aria-disabled="busy || undefined">{{ busy ? "Сохраняем…" : mode === "create" ? "Добавить ответ" : "Сохранить ответ" }}</button>
    </div>
  </form>
</template>
