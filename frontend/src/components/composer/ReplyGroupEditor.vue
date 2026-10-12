<script setup lang="ts">
import { onMounted, ref, useId, useTemplateRef } from "vue";

// A compact name field for a new group or a renamed one: Enter or "Сохранить" sends it, Esc or
// "Отмена" closes it without closing the catalog. The server normalizes and checks the name; its
// refusal is shown here and the typed name stays.
const props = withDefaults(defineProps<{
  label: string;
  initial?: string;
  busy?: boolean;
  error?: string;
}>(), { initial: "", busy: false, error: "" });
const emit = defineEmits<{ save: [name: string]; cancel: [] }>();
const id = useId();
const field = useTemplateRef<HTMLInputElement>("field");
const name = ref(props.initial ? `/${props.initial}` : "");
const problem = ref("");

onMounted(() => {
  field.value?.focus();
  field.value?.select();
});

function save(): void {
  if (props.busy) return;
  problem.value = name.value.replace(/^\//, "").trim() ? "" : "Введите название группы.";
  if (problem.value) {
    field.value?.focus();
    return;
  }
  emit("save", name.value);
}

function cancel(event?: KeyboardEvent): void {
  event?.preventDefault();
  event?.stopPropagation();
  if (!props.busy) emit("cancel");
}
</script>

<template>
  <form class="grid gap-2" novalidate @submit.prevent="save">
    <label :for="id" class="field-label mb-0">{{ label }}</label>
    <input
      :id="id"
      ref="field"
      v-model="name"
      class="field-input"
      maxlength="49"
      autocomplete="off"
      spellcheck="false"
      placeholder="/оплата"
      :aria-invalid="problem || error ? 'true' : undefined"
      :aria-describedby="problem || error ? `${id}-error` : undefined"
      @input="problem = ''"
      @keydown.esc="cancel"
    />
    <p v-if="problem || error" :id="`${id}-error`" class="field-error" role="alert">{{ problem || error }}</p>
    <div class="flex flex-wrap justify-end gap-2">
      <button type="button" class="quiet" :aria-disabled="busy || undefined" @click="cancel()">Отмена</button>
      <button type="submit" class="primary" :aria-disabled="busy || undefined">{{ busy ? "Сохраняем…" : "Сохранить" }}</button>
    </div>
  </form>
</template>
