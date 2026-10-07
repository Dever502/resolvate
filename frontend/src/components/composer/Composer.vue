<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, useTemplateRef, watch } from "vue";
import type { QuickReply } from "../../api/types";
import { fileLabel } from "../../lib/format";
import { useChatStore } from "../../stores/chat";
import { useProjectsStore } from "../../stores/projects";
import { useSessionStore } from "../../stores/session";
import { useWorkspaceStore } from "../../stores/workspace";
import Icon from "../ui/Icon.vue";
import IconButton from "../ui/IconButton.vue";
import QuickReplies from "./QuickReplies.vue";

// The reply box. Every dialogue keeps its own draft (text, file and the idempotency key of the
// last attempt; any edit drops the key, a failed send keeps it). Enter sends, Shift+Enter starts a
// new line, IME composition is left alone. "/" at the start searches the quick replies: arrows
// move through them, Enter inserts one, Esc closes the list. Focus stays in the text field.
const ACCEPT = "image/jpeg,image/png,image/webp,video/mp4,video/quicktime,application/pdf,audio/ogg,audio/opus,.ogg,.opus";
const MAX_HEIGHT = 160;
const REPLY_DELAY = 180;
const chat = useChatStore();
const session = useSessionStore();
const projects = useProjectsStore();
const workspace = useWorkspaceStore();
const field = useTemplateRef<HTMLTextAreaElement>("field");
const picker = useTemplateRef<HTMLInputElement>("picker");
const listId = useId();
/** null: the list is closed. */
const replies = ref<QuickReply[] | null>(null);
const active = ref(0);
let replyTimer: ReturnType<typeof setTimeout> | undefined;
let sequence = 0;

const text = computed(() => chat.draft?.text ?? "");
const file = computed(() => chat.draft?.file ?? null);

/** Grows with the text up to 160 px (a CSSOM height, allowed by the console CSP). */
function resize(): void {
  const element = field.value;
  if (!element) return;
  element.style.height = "auto";
  if (element.getClientRects().length) element.style.height = `${Math.min(MAX_HEIGHT, element.scrollHeight)}px`;
}

function closeReplies(): void {
  clearTimeout(replyTimer);
  sequence++;
  replies.value = null;
}

function onInput(event: Event): void {
  const value = (event.target as HTMLTextAreaElement).value;
  chat.edit(value);
  resize();
  closeReplies();
  if (!/^\/[^\n]*$/.test(value)) return;
  const sent = ++sequence;
  replyTimer = setTimeout(async () => {
    try {
      const found = await session.api<QuickReply[]>(
        `replies?q=${encodeURIComponent(value.slice(1).slice(0, 100))}`, {}, projects.currentId,
      );
      if (sent !== sequence || text.value !== value) return;
      replies.value = found;
      active.value = 0;
    } catch (error) {
      workspace.fail(error);
    }
  }, REPLY_DELAY);
}

async function choose(index: number): Promise<void> {
  const reply = replies.value?.[index];
  if (!reply) return;
  chat.edit(reply.text);
  closeReplies();
  await nextTick();
  resize();
  field.value?.focus();
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.isComposing) return;
  const list = replies.value;
  if (list) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation(); // Closes the list, not the customer card too.
      closeReplies();
      return;
    }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && list.length) {
      event.preventDefault();
      active.value = (active.value + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void choose(active.value);
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void submit();
  }
}

async function submit(): Promise<void> {
  if (chat.sending) return;
  closeReplies();
  await chat.send();
  await nextTick();
  resize();
  field.value?.focus();
}

function onFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  const chosen = input.files?.[0];
  if (chosen) chat.attach(chosen);
  input.value = "";
}

// Another dialogue: its own draft, no open list, and the cursor in the text field.
watch(() => chat.ticketId, async () => {
  closeReplies();
  await nextTick();
  resize();
  field.value?.focus({ preventScroll: true });
}, { immediate: true });

onUnmounted(() => clearTimeout(replyTimer));
</script>

<template>
  <div class="composer-area">
    <QuickReplies v-if="replies" :id="listId" :replies="replies" :active="active" @choose="choose" @hover="active = $event" />
    <div v-if="file" class="attachment">
      <span class="min-w-0 [overflow-wrap:anywhere]">{{ fileLabel(file) }}</span>
      <IconButton class="quiet min-w-9" label="Убрать вложение" :disabled="chat.sending" @click="chat.attach(null)">
        <Icon name="close" />
      </IconButton>
    </div>
    <form class="composer" @submit.prevent="submit">
      <IconButton
        class="icon-button"
        label="Прикрепить файл"
        description="Фото, MP4/MOV, PDF или голосовое OGG/Opus до 20 МБ"
        :disabled="chat.sending"
        @click="picker?.click()"
      >
        <Icon name="attach" />
      </IconButton>
      <input ref="picker" type="file" :accept="ACCEPT" hidden @change="onFile" />
      <textarea
        ref="field"
        :value="text"
        rows="1"
        placeholder="Написать ответ…"
        aria-label="Текст ответа"
        maxlength="3900"
        aria-autocomplete="list"
        :aria-controls="replies ? listId : undefined"
        :aria-activedescendant="replies?.length ? `${listId}-${active}` : undefined"
        :disabled="chat.sending"
        @input="onInput"
        @keydown="onKeyDown"
      />
      <!-- aria-disabled, not disabled: a disabled button drops keyboard focus while the request runs. -->
      <button class="primary send" type="submit" aria-label="Отправить" :aria-disabled="chat.sending || undefined">
        <span class="send-label">Отправить</span><Icon name="send" />
      </button>
    </form>
    <div class="composer-hint">
      <span><kbd>/</kbd> Готовые ответы</span>
      <span class="compact:hidden"><kbd>Enter</kbd> отправить · <kbd>Shift Enter</kbd> новая строка</span>
    </div>
  </div>
</template>
