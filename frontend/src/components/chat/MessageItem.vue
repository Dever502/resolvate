<script setup lang="ts">
import { computed, ref } from "vue";
import type { Message } from "../../api/types";
import { messageTime } from "../../lib/format";
import { useChatStore } from "../../stores/chat";
import { useProjectsStore } from "../../stores/projects";
import Icon from "../ui/Icon.vue";
import MessageMedia from "./MessageMedia.vue";
import StickerView from "./StickerView.vue";

// One message: the customer's on the left, the team's on the right, system events centred.
const CLOSED_EVENT = "✅ Обращение закрыто";
const props = defineProps<{ message: Message; customer: string }>();
const chat = useChatStore();
const projects = useProjectsStore();
const retrying = ref(false);

const outgoing = computed(() => props.message.direction === "operator_to_user");
const author = computed(() =>
  props.message.system ? "Система" : outgoing.value ? props.message.author : props.customer || "Клиент",
);
const url = computed(() => props.message.media_id && projects.currentId
  ? `/console/projects/${projects.currentId}/media/${encodeURIComponent(props.message.media_id)}`
  : "");
const identity = computed(() => {
  const rating = props.message.rating;
  if (!rating) return [];
  const lines: [string, unknown][] = [
    ["", rating.username ? `@${rating.username}` : null],
    ["Telegram ID: ", rating.telegram_user_id],
    ["Email: ", rating.email],
    ["ID клиента: ", rating.telegram_user_id == null ? rating.identity_value : null],
  ];
  return lines.filter(([, value]) => value != null && value !== "").map(([label, value]) => `${label}${String(value)}`);
});

async function retry(): Promise<void> {
  if (retrying.value) return;
  retrying.value = true;
  try {
    await chat.retry(props.message);
  } finally {
    retrying.value = false;
  }
}
</script>

<template>
  <article
    class="message"
    :class="{
      outgoing: outgoing && !message.system,
      system: message.system,
      internal: !message.system && message.channel === 'internal_note',
      'sticker-message': Boolean(url) && message.sticker,
    }"
  >
    <div class="message-meta">
      <span>{{ author }}</span>
      <time :datetime="message.time">{{ messageTime(message.time) }}</time>
    </div>
    <div class="bubble" :class="{ 'rating-card': message.rating }">
      <StickerView v-if="url && message.sticker" :src="url" :mime="message.mime ?? ''" :emoji="message.sticker_emoji ?? ''" />
      <MessageMedia v-else-if="url" :url="url" :mime="message.mime ?? ''" />
      <span v-else-if="message.attachment" class="muted">Вложение недоступно в Web</span>
      <template v-if="message.rating">
        <p class="mb-2.5 text-[.8125rem] font-semibold">Оценка поддержки</p>
        <div class="mb-3.5 flex items-center gap-3">
          <span class="flex gap-0.75 text-rating" aria-hidden="true">
            <Icon v-for="index in 5" :key="index" name="star" class="size-4" :class="{ 'fill-current': index <= message.rating.score }" />
          </span>
          <strong :aria-label="`Оценка: ${message.rating.score} из 5`">{{ message.rating.score }}/5</strong>
        </div>
        <div class="font-medium [overflow-wrap:anywhere]">
          {{ message.rating.display_name || message.rating.username || "Клиент" }}
        </div>
        <span v-for="line in identity" :key="line" class="mt-0.75 block text-xs text-muted [overflow-wrap:anywhere]">{{ line }}</span>
      </template>
      <span v-else-if="message.system && message.text === CLOSED_EVENT" class="inline-flex items-center gap-2">
        <Icon name="check" class="size-4 text-success" />Обращение закрыто
      </span>
      <template v-else-if="message.text">{{ message.text }}</template>
    </div>
    <div v-if="message.failed.length" class="mt-1.5 text-[.8125rem] text-danger">
      Не удалось отправить
      <button class="quiet" type="button" :aria-disabled="retrying || undefined" @click="retry">Повторить</button>
    </div>
  </article>
</template>
