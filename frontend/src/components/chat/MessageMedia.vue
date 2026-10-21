<script setup lang="ts">
import { ref, watch } from "vue";
import { useChatStore } from "../../stores/chat";

// An attachment in a message. Photos show a server-made thumbnail and open the original in the
// viewer; if the thumbnail fails, the original still opens. Voice, video and documents play or
// download from the same protected address. A photo's and a video's room is set before they load
// (app.css, .image-preview and .bubble video): a late thumbnail or video size moves nothing in the
// history. The thumbnail still loads lazily.
const props = defineProps<{ url: string; mime: string }>();
const chat = useChatStore();
const thumbnail = ref<"loading" | "loaded" | "failed">("loading");
watch(() => props.url, () => {
  thumbnail.value = "loading";
});
</script>

<template>
  <button
    v-if="mime.startsWith('image/')"
    class="image-preview"
    type="button"
    aria-label="Открыть изображение"
    :data-state="thumbnail"
    @click="chat.viewer = url"
  >
    <img v-if="thumbnail !== 'failed'" :src="`${url}/thumbnail`" alt="Фото из переписки" loading="lazy"
      @load="thumbnail = 'loaded'" @error="thumbnail = 'failed'" />
    <span v-else class="muted">Открыть изображение</span>
  </button>
  <audio v-else-if="mime.startsWith('audio/')" :src="url" controls preload="metadata" aria-label="Голосовое сообщение" />
  <video v-else-if="mime.startsWith('video/')" :src="url" controls preload="metadata" />
  <a v-else :href="url">↓ Скачать PDF</a>
</template>
