<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";
import type { Project, ProjectSettings } from "../../api/types";
import { errorMessage, useRequest } from "../../composables/useRequest";
import { SETTING_FIELDS, SETTING_SECTIONS, formFrom, payloadFrom, validate, type SettingsForm } from "../../lib/projectSettings";
import { useSessionStore } from "../../stores/session";
import SettingInput from "./SettingInput.vue";

// The project's connections (GET/POST /console/projects/{id}/settings, project administrator only):
// the bot and support group, the site's Web API, Operator API, Remnawave, the notification webhook,
// and under "Дополнительно" message limits, topic rotation and archive retention. Stored secrets are
// never shown; an empty secret field keeps the stored one. Saving is explicit; a refused save keeps
// everything typed, and leaving with unsaved changes asks first (ProjectsDialog).
const props = defineProps<{ project: Project }>();
const dirty = defineModel<boolean>("dirty", { required: true });
const session = useSessionStore();
const request = useRequest();
const formElement = useTemplateRef<HTMLFormElement>("form");
const saved = ref<ProjectSettings | null>(null);
const form = ref<SettingsForm>({});
const initial = ref("");
const errors = ref<Record<string, string>>({});
const attempted = ref(false);
const note = ref("");
const loadError = ref("");
const advancedOpen = ref(false);
let controller: AbortController | null = null;

const changed = computed(() => saved.value !== null && JSON.stringify(form.value) !== initial.value);
const basic = SETTING_SECTIONS.filter((section) => !section.advanced);
const advanced = SETTING_SECTIONS.filter((section) => section.advanced);
const apiBase = computed(() => `${location.origin}/projects/${props.project.id}/api/v1`);

async function load(): Promise<void> {
  controller?.abort();
  const own = new AbortController();
  controller = own;
  loadError.value = "";
  try {
    const values = await session.api<ProjectSettings>(`projects/${props.project.id}/settings`, { signal: own.signal });
    if (own.signal.aborted) return;
    saved.value = values;
    form.value = formFrom(values);
    initial.value = JSON.stringify(form.value);
    errors.value = {};
    attempted.value = false;
  } catch (error) {
    if (!own.signal.aborted) loadError.value = errorMessage(error);
  } finally {
    if (controller === own) controller = null;
  }
}
onMounted(load);
onBeforeUnmount(() => {
  controller?.abort();
  dirty.value = false;
});

watch(changed, (value) => { dirty.value = value; }, { immediate: true });
// After a refused attempt the marks follow the corrections.
watch(form, () => {
  if (attempted.value && saved.value) errors.value = validate(form.value, saved.value);
  note.value = "";
}, { deep: true });

async function submit(): Promise<void> {
  if (request.busy || !saved.value) return;
  attempted.value = true;
  errors.value = validate(form.value, saved.value);
  const invalid = SETTING_FIELDS.find((field) => errors.value[field.key]);
  if (invalid) {
    request.clear();
    note.value = "Исправьте отмеченные поля.";
    if (advanced.some((section) => section.fields.includes(invalid))) advancedOpen.value = true;
    await nextTick();
    formElement.value?.querySelector<HTMLElement>(`[data-field="${invalid.key}"]`)?.focus();
    return;
  }
  if (!changed.value) {
    request.clear();
    note.value = "Изменений нет.";
    return;
  }
  const settings = payloadFrom(form.value);
  await request.run(async () => {
    await session.api(`projects/${props.project.id}/settings`, { method: "POST", data: { settings } });
    // The server took these values: the form counts as saved even if reading them back fails.
    const stored: ProjectSettings = { ...saved.value };
    for (const field of SETTING_FIELDS) {
      if (field.key in settings) stored[field.key] = field.kind === "secret" ? true : settings[field.key] ?? null;
    }
    saved.value = stored;
    form.value = formFrom(stored);
    initial.value = JSON.stringify(form.value);
    errors.value = {};
    attempted.value = false;
    await load();
    return "Подключения сохранены. Активный проект перезапустится автоматически.";
  });
}

function cancel(): void {
  if (request.busy || !saved.value) return;
  form.value = formFrom(saved.value);
  errors.value = {};
  attempted.value = false;
  request.clear();
}
</script>

<template>
  <div>
    <!-- A failed read is shown above the form, which keeps what is on screen. -->
    <p v-if="loadError" class="error" role="alert">
      {{ loadError }}
      <button type="button" class="quiet ml-1" @click="load">Повторить</button>
    </p>
    <p v-else-if="!saved" class="muted">Загружаем подключения…</p>
    <form v-if="saved" ref="form" class="grid gap-3" novalidate :aria-busy="request.busy || undefined" @submit.prevent="submit">
      <p class="muted small m-0">
        Сохранённые ключи не показываются: пустое поле оставляет прежний ключ. После первого сохранения бот и группа закрепляются за проектом.
      </p>
      <fieldset v-for="section in basic" :key="section.title" class="settings-section">
        <legend>{{ section.title }}</legend>
        <p v-if="section.title === 'API для вашего сайта'" class="muted small m-0 [overflow-wrap:anywhere]">
          Базовый адрес API: <code>{{ apiBase }}</code>
        </p>
        <SettingInput
          v-for="field in section.fields"
          :key="field.key"
          v-model="form[field.key]"
          :field="field"
          :error="errors[field.key]"
          :stored="saved[field.key] === true"
        />
      </fieldset>
      <details class="disclosure" :open="advancedOpen" @toggle="advancedOpen = ($event.target as HTMLDetailsElement).open">
        <summary>Дополнительно: лимиты, темы и хранение архива</summary>
        <fieldset v-for="section in advanced" :key="section.title" class="settings-section">
          <legend>{{ section.title }}</legend>
          <SettingInput
            v-for="field in section.fields"
            :key="field.key"
            v-model="form[field.key]"
            :field="field"
            :error="errors[field.key]"
          />
        </fieldset>
      </details>
      <p v-if="request.status" class="error" :class="{ success: !request.failed }" :role="request.failed ? 'alert' : 'status'">{{ request.status }}</p>
      <p v-else-if="note" class="error" :class="{ success: note === 'Изменений нет.' }" role="status">{{ note }}</p>
      <div class="flex flex-wrap justify-end gap-2">
        <button v-if="changed" type="button" class="quiet" :aria-disabled="request.busy || undefined" @click="cancel">Отменить изменения</button>
        <button type="submit" class="primary" :aria-disabled="request.busy || undefined">{{ request.busy ? "Сохраняем…" : "Сохранить подключения" }}</button>
      </div>
    </form>
  </div>
</template>
