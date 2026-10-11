<script setup lang="ts">
import { computed, ref, useId, useTemplateRef, watch } from "vue";
import type { Project } from "../../api/types";
import { useRequest } from "../../composables/useRequest";
import { initials } from "../../lib/initials";
import { LOGO_TYPES, fileSize, logoProblem } from "../../lib/logo";
import { logoUrl, useProjectsStore } from "../../stores/projects";
import ConfirmDialog from "../ui/ConfirmDialog.vue";

// The project's logo (project administrator only): the current one, a new image with a preview,
// upload or replacement, and removal after a confirmation. The server normalizes the image to a
// PNG of at most 512×512; afterwards the project list carries the new version, so the app bar and
// the lists show it at once. The preview decodes the file into a canvas: the console CSP allows no
// blob: or data: images.
const props = defineProps<{ project: Project }>();
const projects = useProjectsStore();
const request = useRequest();
const confirm = useRequest();
const id = useId();
const input = useTemplateRef<HTMLInputElement>("input");
const canvas = useTemplateRef<HTMLCanvasElement>("canvas");
const file = ref<File | null>(null);
const problem = ref("");
const previewReady = ref(false);
const previewFailed = ref(false);
const removing = ref(false);
// After the removal its button is gone: focus goes to the file field instead.
let focusInput = false;
const current = computed(() => (props.project.logo ? logoUrl(props.project) : ""));
const currentFailed = ref(false);
const removingOpen = computed({
  get: () => removing.value,
  set: (value) => { if (!value && !confirm.busy) removing.value = false; },
});
watch(current, () => { currentFailed.value = false; });

function choose(event: Event): void {
  const chosen = (event.target as HTMLInputElement).files?.[0] ?? null;
  request.clear();
  problem.value = chosen ? logoProblem(chosen) : "";
  file.value = chosen && !problem.value ? chosen : null;
}

function forget(): void {
  file.value = null;
  if (input.value) input.value.value = "";
}

watch([file, canvas], async ([chosen, target], _previous, onCleanup) => {
  let stale = false;
  previewReady.value = false;
  previewFailed.value = false;
  onCleanup(() => {
    stale = true;
    if (target) { target.width = 1; target.height = 1; }
  });
  if (!chosen || !target) return;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(chosen);
    if (stale) return;
    const context = target.getContext("2d");
    if (!context || !bitmap.width || !bitmap.height) throw new Error("Preview unavailable");
    const scale = Math.min(128 / bitmap.width, 128 / bitmap.height, 1);
    target.width = Math.max(1, Math.round(bitmap.width * scale));
    target.height = Math.max(1, Math.round(bitmap.height * scale));
    context.drawImage(bitmap, 0, 0, target.width, target.height);
    previewReady.value = true;
  } catch {
    if (!stale) previewFailed.value = true;
  } finally {
    bitmap?.close();
  }
}, { flush: "post" });

async function upload(): Promise<void> {
  if (request.busy) return;
  const chosen = file.value;
  if (!chosen) {
    problem.value ||= "Выберите изображение PNG, JPEG или WebP до 2 МБ.";
    input.value?.focus();
    return;
  }
  const replacing = Boolean(props.project.logo);
  const done = await request.run(async () => {
    await projects.uploadLogo(props.project.id, chosen);
    return replacing ? "Логотип заменён." : "Логотип сохранён.";
  });
  if (done) forget();
}

function afterConfirm(event: Event): void {
  if (!focusInput) return;
  focusInput = false;
  event.preventDefault();
  input.value?.focus();
}

function askRemove(): void {
  if (request.busy) return;
  confirm.clear();
  removing.value = true;
}

async function remove(): Promise<void> {
  const done = await confirm.run(() => projects.removeLogo(props.project.id));
  if (!done) return;
  focusInput = true;
  removing.value = false;
  request.clear();
  request.status = "Логотип удалён.";
}
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center gap-4">
      <div class="logo-frame" aria-hidden="true">
        <img v-if="current && !currentFailed" :src="current" alt="" @error="currentFailed = true" />
        <span v-else>{{ initials(project.name) }}</span>
      </div>
      <div class="min-w-0 flex-1">
        <p class="m-0 font-semibold">{{ project.logo ? "Текущий логотип" : "Логотипа нет" }}</p>
        <p class="muted small m-0">
          {{ project.logo ? "Показывается в шапке и в списке проектов." : "Вместо логотипа показывается первая буква названия." }}
          PNG, JPEG или WebP до 2 МБ; сервер сохраняет PNG не больше 512 × 512 без метаданных.
        </p>
      </div>
    </div>
    <form class="mt-4" novalidate :aria-busy="request.busy || undefined" @submit.prevent="upload">
      <label :for="id" class="field-label">{{ project.logo ? "Новое изображение" : "Изображение" }}</label>
      <input
        :id="id"
        ref="input"
        class="field-input"
        type="file"
        :accept="LOGO_TYPES.join(',')"
        :aria-invalid="problem ? 'true' : undefined"
        :aria-describedby="problem ? `${id}-error` : undefined"
        :disabled="request.busy"
        @change="choose"
      />
      <p v-if="problem" :id="`${id}-error`" class="field-error">{{ problem }}</p>
      <div v-if="file" class="logo-preview" role="group" aria-label="Выбранное изображение">
        <div class="logo-frame" aria-hidden="true">
          <canvas v-show="previewReady" ref="canvas" />
        </div>
        <div class="min-w-0">
          <p class="m-0 truncate font-medium" :title="file.name">{{ file.name }}</p>
          <p class="muted small m-0">{{ fileSize(file.size) }}</p>
          <p v-if="previewFailed" class="muted small m-0" role="status">Предпросмотр недоступен; сервер проверит изображение при загрузке.</p>
        </div>
      </div>
      <progress v-if="request.busy" class="logo-progress" aria-label="Загрузка логотипа" />
      <p v-if="request.status" class="error" :class="{ success: !request.failed }" :role="request.failed ? 'alert' : 'status'">{{ request.status }}</p>
      <div class="mt-4 flex flex-wrap justify-end gap-2">
        <button v-if="project.logo" type="button" class="quiet" :aria-disabled="request.busy || undefined" @click="askRemove">Удалить логотип</button>
        <button type="submit" class="primary" :aria-disabled="request.busy || undefined">
          {{ request.busy ? "Загружаем…" : project.logo ? "Заменить логотип" : "Загрузить логотип" }}
        </button>
      </div>
    </form>
    <ConfirmDialog
      v-model:open="removingOpen"
      :title="`Удалить логотип проекта «${project.name}»?`"
      description="В шапке и в списке проектов вместо логотипа появится первая буква названия. Логотип можно загрузить снова."
      confirm-label="Удалить логотип"
      busy-label="Удаляем…"
      :busy="confirm.busy"
      :error="confirm.failed ? confirm.status : ''"
      danger
      @confirm="remove"
      @close-auto-focus="afterConfirm"
    />
  </div>
</template>
