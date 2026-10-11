<script setup lang="ts">
import { computed, useId } from "vue";
import { IDENTITY_MODES, type SettingField } from "../../lib/projectSettings";

// One field of the connections form: a switch, the identity mode, or a text field with its hint
// and error. `data-field` lets the form focus the first field to correct.
const props = withDefaults(defineProps<{ field: SettingField; error?: string; stored?: boolean }>(), { error: "", stored: false });
// Every key is filled by formFrom(); the index type of the form still allows undefined.
const value = defineModel<string | boolean | undefined>({ required: true });
const id = useId();
const described = computed(() =>
  [props.field.hint ? `${id}-hint` : "", props.error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined);
const placeholder = computed(() => {
  const kind = props.field.kind;
  if (kind === "secret") return props.stored ? "Ключ сохранён" : "Не настроено";
  if (kind === "group") return "-100…";
  if (kind === "url") return "https://…";
  if (kind === "limit") return "Автоматически";
  return "";
});
</script>

<template>
  <div v-if="field.kind === 'toggle'" class="toggle-field">
    <input :id="id" v-model="value" type="checkbox" :data-field="field.key" />
    <label :for="id">{{ field.label }}</label>
  </div>
  <fieldset v-else-if="field.kind === 'identity'" class="choice-field" :aria-describedby="described">
    <legend class="field-label">{{ field.label }}</legend>
    <div v-for="(mode, index) in IDENTITY_MODES" :key="mode.value" class="toggle-field">
      <input :id="`${id}-${mode.value}`" v-model="value" type="radio" :name="id" :value="mode.value" :data-field="index ? undefined : field.key" />
      <label :for="`${id}-${mode.value}`">{{ mode.label }}</label>
    </div>
    <p v-if="field.hint" :id="`${id}-hint`" class="muted small m-0">{{ field.hint }}</p>
  </fieldset>
  <div v-else>
    <label :for="id" class="field-label">{{ field.label }}</label>
    <input
      :id="id"
      v-model="value"
      class="field-input"
      :data-field="field.key"
      :type="field.kind === 'secret' ? 'password' : field.kind === 'url' ? 'url' : 'text'"
      :inputmode="['group', 'count', 'limit'].includes(field.kind) ? 'numeric' : undefined"
      :autocomplete="field.kind === 'secret' ? 'new-password' : 'off'"
      :maxlength="field.kind === 'group' ? 17 : undefined"
      spellcheck="false"
      :placeholder="placeholder"
      :aria-invalid="error ? 'true' : undefined"
      :aria-describedby="described"
    />
    <p v-if="field.hint" :id="`${id}-hint`" class="muted small mt-1.5 mb-0">{{ field.hint }}</p>
    <p v-if="error" :id="`${id}-error`" class="field-error">{{ error }}</p>
  </div>
</template>
