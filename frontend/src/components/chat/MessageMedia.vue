<script setup lang="ts">
import { ref, watch } from "vue";
import { useChatStore } from "../../stores/chat";

// An attachment in a message. Photos show a server-made thumbnail and open the original in the
// viewer; if the thumbnail fails, the original still opens. Voice, video and documents play or
// download from the same protected address.
const props = defineProps<{ url: string; mime: string }>();
const chat = useChatStore();
const thumbnailFailed = ref(false);
watch(() => props.url, () => {
  thumbnailFailed.value = false;
});
</script>

<template>
  <button
    v-if="mime.startsWith('image/')"
    class="image-preview"
    type="button"
    aria-label="Открыть изображение"
    @click="chat.viewer = url"
  >
    <img v-if="!thumbnailFailed" :src="`${url}/thumbnail`" alt="Фото из переписки" loading="lazy" @error="thumbnailFailed = true" />
    <span v-else class="muted">Открыть изображение</span>
  </button>
  <audio v-else-if="mime.startsWith('audio/')" :src="url" controls preload="metadata" aria-label="Голосовое сообщение" />
  <video v-else-if="mime.startsWith('video/')" :src="url" controls preload="metadata" />
  <a v-else :href="url">↓ Скачать PDF</a>
</template>
