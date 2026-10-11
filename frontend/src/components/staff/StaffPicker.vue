<script setup lang="ts">
import { ComboboxAnchor, ComboboxContent, ComboboxInput, ComboboxItem, ComboboxRoot } from "reka-ui";
import { nextTick, onBeforeUnmount, ref, useId, useTemplateRef, watch } from "vue";

export interface StaffOption {
  /** The login: what the server's account routes take. */
  value: string;
  label: string;
  detail: string;
}

// One employee chosen by search, on Reka Combobox: the input asks the search (the server's, or a
// filter of a loaded list) 200 ms after typing, arrows move through the answers, Enter picks one,
// Esc closes the list, and focus stays in the input. ComboboxViewport is not used: it adds an inline
// style element, which the console CSP blocks; the list scrolls by itself.
const props = withDefaults(defineProps<{
  label: string;
  /** The options for a query; a search that was replaced is aborted and ignored. */
  search: (query: string, signal: AbortSignal) => Promise<StaffOption[]>;
  placeholder?: string;
  disabled?: boolean;
  /** The search answers at most this many: reaching it asks to narrow the query. */
  limit?: number;
  /** The status once someone is chosen: the next step. */
  chosenHint?: string;
  /** Why the form refused to go on (nobody chosen): announced and tied to the field. */
  error?: string;
}>(), { placeholder: "Найти по имени или логину", disabled: false, limit: 50, chosenHint: "", error: "" });
const chosen = defineModel<StaffOption | null>({ required: true });

const id = useId();
const root = useTemplateRef<{ highlightFirstItem?: () => void }>("root");
const display = (option: StaffOption) => `${option.label} · ${option.detail}`;
const query = ref(chosen.value ? display(chosen.value) : "");
const options = ref<StaffOption[]>([]);
const open = ref(false);
const status = ref(chosen.value ? props.chosenHint : "");
let timer: ReturnType<typeof setTimeout> | undefined;
let controller: AbortController | null = null;
let request = 0;

function stop(): void {
  clearTimeout(timer);
  controller?.abort();
  controller = null;
  request++;
}

async function load(): Promise<void> {
  if (props.disabled) return;
  stop();
  const own = new AbortController();
  controller = own;
  const sent = request;
  // With someone chosen the field shows them, not a query: the list then offers everyone again.
  const term = chosen.value ? "" : query.value.trim();
  status.value = "Загрузка сотрудников…";
  try {
    const found = await props.search(term, own.signal);
    if (sent !== request) return;
    options.value = found;
    open.value = found.length > 0;
    status.value = !found.length ? "Нет доступных сотрудников по этому запросу."
      : found.length >= props.limit ? `Показаны первые ${props.limit} сотрудников. Уточните поиск.`
        : "Выберите сотрудника из списка.";
    // The first answer is highlighted, so Enter takes it in every browser (Reka does it on its
    // own only when the new items happen to mount before its check).
    await nextTick();
    if (sent === request && open.value) root.value?.highlightFirstItem?.();
  } catch {
    if (sent !== request) return;
    options.value = [];
    open.value = false;
    status.value = "Не удалось загрузить сотрудников. Нажмите на поле, чтобы повторить.";
  } finally {
    if (controller === own) controller = null;
  }
}

function typed(): void {
  chosen.value = null;
  stop();
  open.value = false;
  status.value = "Поиск…";
  timer = setTimeout(() => void load(), 200);
}

function clicked(): void {
  if (!open.value && !controller) void load();
}

// Arrows open the list (Reka); with nothing loaded yet they start the search.
watch(open, (value) => {
  if (value && !options.value.length && !controller) void load();
});
watch(chosen, (option) => {
  if (!option) return;
  query.value = display(option);
  status.value = props.chosenHint;
});
onBeforeUnmount(stop);
</script>

<template>
  <div>
    <ComboboxRoot
      ref="root"
      v-model="chosen"
      v-model:open="open"
      by="value"
      class="relative"
      :ignore-filter="true"
      :reset-search-term-on-blur="false"
      :reset-search-term-on-select="false"
      :disabled="disabled"
    >
      <label :for="`${id}-input`" class="field-label">{{ label }}</label>
      <ComboboxAnchor class="block">
        <ComboboxInput
          :id="`${id}-input`"
          v-model="query"
          class="field-input"
          :placeholder="placeholder"
          maxlength="100"
          spellcheck="false"
          :aria-describedby="error ? `${id}-status ${id}-error` : `${id}-status`"
          :aria-invalid="error ? 'true' : undefined"
          @input="typed"
          @focus="load"
          @click="clicked"
        />
      </ComboboxAnchor>
      <ComboboxContent position="inline" class="picker-options" :hide-when-empty="true" aria-label="Сотрудники">
        <ComboboxItem v-for="option in options" :key="option.value" :value="option" :text-value="option.label" class="picker-option">
          <span class="min-w-0 truncate font-medium">{{ option.label }}</span>
          <span class="muted small min-w-0 truncate">{{ option.detail }}</span>
        </ComboboxItem>
      </ComboboxContent>
    </ComboboxRoot>
    <p :id="`${id}-status`" class="muted small mt-1.5 mb-0" role="status">{{ status }}</p>
    <p v-if="error" :id="`${id}-error`" class="field-error" role="alert">{{ error }}</p>
  </div>
</template>
