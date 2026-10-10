<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, useTemplateRef, watch } from "vue";
import type { QuickReply, QuickReplyGroup } from "../../api/types";
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
const repliesOpen = ref(false);
const replies = ref<QuickReply[]>([]);
const groups = ref<QuickReplyGroup[]>([]);
const group = ref<QuickReplyGroup | null>(null);
const query = ref("");
const buttonMode = ref(false);
const loading = ref(false);
const hasMore = ref(false);
const options = computed(() => group.value ? replies.value : groups.value.map(g => ({ id: g.id, text: '/' + g.name })));
let insertAt = 0;
let insertEnd = 0;
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
  repliesOpen.value = false;
  replies.value = [];
  groups.value = [];
  group.value = null;
  loading.value = false;
}

function search(value: string, more = false): void {
  query.value = value;
  clearTimeout(replyTimer);
  const sent = ++sequence;
  const projectId = projects.currentId;
  const selected = group.value;
  if (!more) { replies.value = []; groups.value = []; active.value = 0; }
  const offset = more ? options.value.length : 0;
  loading.value = true;
  hasMore.value = false;
  replyTimer = setTimeout(async () => {
    try {
      const path = selected ? `replies?group_id=${selected.id}&` : "reply-groups?";
      const url = `${path}q=${encodeURIComponent(value.slice(0, 100))}&offset=${offset}`;
      if (selected) {
        const found = await session.api<QuickReply[]>(url, {}, projectId);
        if (sent !== sequence || projects.currentId !== projectId) return;
        replies.value = more ? [...replies.value, ...found] : found;
        hasMore.value = found.length === 50;
      } else {
        const found = await session.api<QuickReplyGroup[]>(url, {}, projectId);
        if (sent !== sequence || projects.currentId !== projectId) return;
        groups.value = more ? [...groups.value, ...found] : found;
        hasMore.value = found.length === 50;
      }
    } catch (error) {
      if (sent === sequence) workspace.fail(error);
    } finally {
      if (sent === sequence) loading.value = false;
    }
  }, REPLY_DELAY);
}

function onInput(event: Event): void {
  const value = (event.target as HTMLTextAreaElement).value;
  chat.edit(value);
  resize();
  if (!/^\/[^\n]*$/.test(value)) { closeReplies(); return; }
  buttonMode.value = false;
  repliesOpen.value = true;
  const prefix = group.value ? `/${group.value.name} ` : "";
  if (prefix && value.startsWith(prefix)) search(value.slice(prefix.length));
  else { group.value = null; search(value.slice(1)); }
}

async function openByButton(): Promise<void> {
  if (repliesOpen.value) { closeReplies(); return; }
  insertAt = field.value?.selectionStart ?? text.value.length;
  insertEnd = field.value?.selectionEnd ?? insertAt;
  buttonMode.value = true;
  repliesOpen.value = true;
  search("");
  await nextTick();
  document.querySelector<HTMLInputElement>('[aria-label="Поиск готовых ответов"]')?.focus();
}

function back(): void {
  group.value = null;
  if (!buttonMode.value) chat.edit("/");
  search("");
}

async function choose(index: number): Promise<void> {
  if (loading.value) return;
  if (!group.value) {
    const selected = groups.value[index];
    if (!selected) return;
    group.value = selected;
    if (!buttonMode.value) chat.edit(`/${selected.name} `);
    search("");
    return;
  }
  const reply = replies.value[index];
  if (!reply) return;
  const next = buttonMode.value ? text.value.slice(0, insertAt) + reply.text + text.value.slice(insertEnd) : reply.text;
  if (next.length > 3900) { workspace.show("Ответ вместе с черновиком превышает 3900 символов."); return; }
  chat.edit(next);
  closeReplies();
  await nextTick();
  resize();
  field.value?.focus();
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.isComposing) return;
  const list = options.value;
  if (repliesOpen.value) {
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
watch(() => [chat.ticketId, projects.currentId], async () => {
  closeReplies();
  await nextTick();
  resize();
  field.value?.focus({ preventScroll: true });
}, { immediate: true });

onUnmounted(closeReplies);
</script>

<template>
  <div class="composer-area">
    <QuickReplies v-if="repliesOpen" :id="listId" :replies="options" :active="active"
      :group="group?.name ?? ''" :loading="loading" :more="hasMore" :query="query" :button-mode="buttonMode"
      @choose="choose" @hover="active = $event" @back="back" @close="closeReplies"
      @search="search" @more="search(query, true)" @keydown="onKeyDown" />
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
      <IconButton class="icon-button" label="Готовые ответы" :disabled="chat.sending"
        :aria-expanded="repliesOpen" @click="openByButton"><span aria-hidden="true">/</span></IconButton>
      <textarea
        ref="field"
        :value="text"
        rows="1"
        placeholder="Написать ответ…"
        aria-label="Текст ответа"
        maxlength="3900"
        aria-autocomplete="list"
        :aria-controls="repliesOpen ? listId : undefined"
        :aria-activedescendant="repliesOpen && options.length ? `${listId}-${active}` : undefined"
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
