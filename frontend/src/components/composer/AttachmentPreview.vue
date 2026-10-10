<script setup lang="ts">
import { computed, ref, useTemplateRef, watch } from "vue";
import Icon from "../ui/Icon.vue";
import IconButton from "../ui/IconButton.vue";

const props = defineProps<{ file: File; disabled: boolean }>();
defineEmits<{ remove: [] }>();
const canvas = useTemplateRef<HTMLCanvasElement>("canvas");
const ready = ref(false);
const failed = ref(false);
const kind = computed(() => {
  const mime = props.file.type.toLowerCase();
  if (["image/jpeg", "image/png", "image/webp"].includes(mime)) return "image";
  if (["video/mp4", "video/quicktime"].includes(mime)) return "video";
  if (mime === "application/pdf") return "document";
  if (["audio/ogg", "audio/opus"].includes(mime)) return "audio";
  // Some file pickers leave MIME empty (notably .opus). Never preview arbitrary image/*.
  if (!mime || mime === "application/octet-stream") {
    const extension = props.file.name.split(".").pop()?.toLowerCase();
    if (["jpg", "jpeg", "png", "webp"].includes(extension ?? "")) return "image";
    if (["mp4", "mov"].includes(extension ?? "")) return "video";
    if (extension === "pdf") return "document";
    if (["ogg", "opus"].includes(extension ?? "")) return "audio";
  }
  return "file";
});
const label = computed(() => ({ image: "Изображение", video: "Видео", document: "PDF", audio: "Аудио", file: "Файл" })[kind.value]);
const size = computed(() => {
  const bytes = props.file.size;
  if (bytes < 1024) return `${bytes} Б`;
  const unit = bytes < 1024 ** 2 ? "КБ" : "МБ";
  return `${(bytes / (unit === "КБ" ? 1024 : 1024 ** 2)).toLocaleString("ru", { maximumFractionDigits: 1 })} ${unit}`;
});
const hint = computed(() => {
  if (kind.value === "file") return "Формат не поддерживается";
  if (kind.value === "video" || failed.value) return "Предпросмотр недоступен";
  if (kind.value === "image" && !ready.value) return "Подготовка превью…";
  return "";
});

// Production CSP permits neither blob: nor data: images/media. Decode the File directly,
// draw a bounded thumbnail, and release the bitmap immediately. No object URLs, upload,
// PDF renderer or video decoder is needed. Video keeps its explicit icon fallback.
watch([() => props.file, canvas], async ([file, target], _previous, onCleanup) => {
  let stale = false;
  ready.value = false;
  failed.value = false;
  onCleanup(() => {
    stale = true;
    // Also releases the canvas backing store on removal, send, switch and unmount.
    if (target) { target.width = 1; target.height = 1; }
  });
  if (!target || kind.value !== "image") return;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    if (stale || !target) return;
    const context = target.getContext("2d");
    if (!context || !bitmap.width || !bitmap.height) throw new Error("Preview unavailable");
    const scale = Math.min(192 / bitmap.width, 128 / bitmap.height, 1);
    target.width = Math.max(1, Math.round(bitmap.width * scale));
    target.height = Math.max(1, Math.round(bitmap.height * scale));
    context.drawImage(bitmap, 0, 0, target.width, target.height);
    ready.value = true;
  } catch {
    if (!stale) failed.value = true;
  } finally {
    bitmap?.close();
  }
}, { immediate: true, flush: "post" });
</script>

<template>
  <div class="attachment-preview" role="group" aria-label="Выбранное вложение">
    <div class="attachment-preview-art" aria-hidden="true">
      <canvas ref="canvas" v-show="ready" />
      <Icon v-if="!ready" :name="kind" />
    </div>
    <div class="attachment-preview-info">
      <p class="attachment-preview-name" :title="file.name">{{ file.name }}</p>
      <p class="attachment-preview-meta">{{ label }} · {{ size }}</p>
      <p v-if="hint" class="attachment-preview-hint" role="status">{{ hint }}</p>
    </div>
    <IconButton class="quiet attachment-preview-remove" label="Убрать вложение" :disabled="disabled" @click="$emit('remove')">
      <Icon name="close" />
    </IconButton>
  </div>
</template>
