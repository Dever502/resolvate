<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, useTemplateRef, watch } from "vue";
import type { QuickReply, QuickReplyGroup } from "../../api/types";
import { MAX_FILES, pastedFile, quoted, textLength, textLimit, tooLong, type AttachmentStatus } from "../../lib/attachment";
import { fileId, useChatStore } from "../../stores/chat";
import { useProjectsStore } from "../../stores/projects";
import { useSessionStore } from "../../stores/session";
import { useWorkspaceStore } from "../../stores/workspace";
import Icon from "../ui/Icon.vue";
import IconButton from "../ui/IconButton.vue";
import QuickReplies from "./QuickReplies.vue";
import AttachmentPreview from "./AttachmentPreview.vue";
import SendAttemptNotice from "./SendAttemptNotice.vue";

// The reply box. Every dialogue keeps its own draft (text and up to five files, picked, dropped or
// pasted). Each message of a send is an attempt of its own (stores/chat.ts): one whose answer never
// came stays above the box until it is sent again under its key or given up, and editing the draft
// never changes it. Several files go one after another, the text as the first one's caption; the box
// says how far they got. Enter sends, Shift+Enter starts a new line, IME composition is left alone.
// "/" at the start searches the quick replies: arrows move through them, Enter inserts one, Esc
// closes the list. Focus stays in the text field. The "/" button opens the same list with a search
// field of its own, which then holds the focus; Esc gives it back to the button, and a reply goes
// where the cursor (or the selection) was.
const ACCEPT = "image/jpeg,image/png,image/webp,video/mp4,video/quicktime,application/pdf,audio/ogg,audio/opus,.ogg,.opus";
const MAX_HEIGHT = 160;
const REPLY_DELAY = 180;
const chat = useChatStore();
const session = useSessionStore();
const projects = useProjectsStore();
const workspace = useWorkspaceStore();
const field = useTemplateRef<HTMLTextAreaElement>("field");
const tray = useTemplateRef<HTMLElement>("tray");
const picker = useTemplateRef<HTMLInputElement>("picker");
const attemptNotice = useTemplateRef<{ focusRetry: () => void }>("attempt-notice");
const listId = useId();
const repliesButtonId = useId();
const limitId = useId();
const repliesOpen = ref(false);
const replies = ref<QuickReply[]>([]);
const groups = ref<QuickReplyGroup[]>([]);
const group = ref<QuickReplyGroup | null>(null);
const query = ref("");
const buttonMode = ref(false);
const loading = ref(false);
/** The last lookup failed: said in the list, with a retry, apart from "nothing found". */
const failed = ref(false);
const hasMore = ref(false);
const options = computed(() => group.value ? replies.value : groups.value.map(g => ({ id: g.id, text: '/' + g.name })));
let insertAt = 0;
let insertEnd = 0;
const active = ref(0);
let replyTimer: ReturnType<typeof setTimeout> | undefined;
let sequence = 0;

const text = computed(() => chat.draft?.text ?? "");
const files = computed(() => chat.draft?.files ?? []);
const withFiles = computed(() => files.value.length > 0);
// The text as the server counts it, against its limit as a caption or alone (lib/attachment.ts).
// Over the limit the text stays editable and as typed; the send says why it does not go.
const length = computed(() => textLength(text.value));
const limit = computed(() => textLimit(withFiles.value));
const overLimit = computed(() => length.value > limit.value);
/** An attempt whose answer never came; it stays shown while it is being sent again. */
const unresolved = computed(() => (chat.attempt && (chat.attempt.state === "unknown" || chat.attempt.reason) ? chat.attempt : null));
/** The open dialogue's reply whose files are on their way, or stopped part way. */
const queue = computed(() => {
  const shown = chat.progress;
  return shown && shown.ticket === chat.ticketId && shown.project === projects.currentId ? shown : null;
});
const queueRunning = computed(() => queue.value?.state === "running" || queue.value?.state === "stopping");
const progressText = computed(() => {
  const shown = queue.value;
  if (!shown) return "";
  const taken = `Принято сервером: ${shown.accepted} из ${shown.total}.`;
  if (shown.state === "running") return `Отправка файла ${Math.min(shown.accepted + 1, shown.total)} из ${shown.total}. ${taken}`;
  if (shown.state === "stopping") return `Отправка остановится после текущего файла. ${taken}`;
  const left = files.value.length ? " Неотправленные файлы остались в черновике: «Отправить» продолжит." : "";
  return `Отправка остановлена${shown.stoppedAt ? ` на ${quoted(shown.stoppedAt)}` : ""}. ${taken}${left}`;
});

/** The same file, or its copy read back from the browser's storage after a reload. */
const sameDescription = (a: File, b: File): boolean =>
  a === b || (a.name === b.name && a.type === b.type && a.size === b.size && a.lastModified === b.lastModified);

/** Where a file of the draft is in a send. */
function status(item: File): AttachmentStatus {
  if (chat.inFlight === item) return "sending";
  const pending = unresolved.value;
  if (pending?.file && pending.state === "unknown" && sameDescription(pending.file, item)) return "unknown";
  return queueRunning.value ? "waiting" : null;
}

/** A file can be removed until its own send starts; while a reply's files go, the waiting ones can. */
const removable = (item: File): boolean => !chat.sending || (queueRunning.value && chat.inFlight !== item);

/** Removes a file; focus goes to the next file's remove button, or the previous one, or the text field. */
async function detach(item: File): Promise<void> {
  const index = files.value.indexOf(item);
  chat.detach(item);
  await nextTick();
  const buttons = tray.value?.querySelectorAll<HTMLButtonElement>(".attachment-preview-remove") ?? [];
  const next = buttons[Math.min(index, buttons.length - 1)];
  if (next) next.focus();
  else field.value?.focus();
}

/** Grows with the text up to 160 px (a CSSOM height, allowed by the console CSP). */
function resize(): void {
  const element = field.value;
  if (!element) return;
  element.style.height = "auto";
  // An empty textarea's scrollHeight includes its placeholder, which can wrap in wider system
  // fonts on phones. Only the operator's text should grow the box; CSS keeps an empty row compact.
  if (element.value && element.getClientRects().length) element.style.height = `${Math.min(MAX_HEIGHT, element.scrollHeight)}px`;
}

function closeReplies(): void {
  clearTimeout(replyTimer);
  sequence++;
  repliesOpen.value = false;
  replies.value = [];
  groups.value = [];
  group.value = null;
  loading.value = false;
  failed.value = false;
}

/** Closes the list: focus goes back where it was opened from, the "/" button or the text field. */
async function dismiss(): Promise<void> {
  const fromButton = buttonMode.value;
  closeReplies();
  await nextTick();
  if (fromButton) document.getElementById(repliesButtonId)?.focus();
  else field.value?.focus();
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
  failed.value = false;
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
    } catch {
      if (sent === sequence) failed.value = true;
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
  const inserted = buttonMode.value;
  const next = inserted ? text.value.slice(0, insertAt) + reply.text + text.value.slice(insertEnd) : reply.text;
  if (textLength(next) > limit.value) { workspace.show(`Ответ вместе с черновиком превышает ${limit.value} символов.`); return; }
  chat.edit(next);
  closeReplies();
  await nextTick();
  resize();
  field.value?.focus();
  // The cursor goes right after the reply, where the operator goes on writing.
  if (inserted) field.value?.setSelectionRange(insertAt + reply.text.length, insertAt + reply.text.length);
}

function onKeyDown(event: KeyboardEvent): void {
  // Safari ends a composition with a keydown that is no longer "composing" but still has keyCode 229.
  if (event.isComposing || event.keyCode === 229) return;
  const list = options.value;
  if (repliesOpen.value) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation(); // Closes the list, not the customer card too.
      void dismiss();
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
  const outcome = await chat.send();
  await nextTick();
  resize();
  // A changed draft waits for the earlier attempt: its choice gets the focus.
  if (outcome === "blocked") attemptNotice.value?.focusRetry();
  else field.value?.focus();
}

async function retryAttempt(): Promise<void> {
  await chat.retrySend();
  await nextTick();
  resize();
  if (unresolved.value) attemptNotice.value?.focusRetry();
  else field.value?.focus();
}

function forgetAttempt(): void {
  chat.forgetAttempt();
  field.value?.focus();
}

// The history settled the attempt while its banner had focus: focus goes back to the reply box.
watch(unresolved, async (value, old) => {
  if (value || !old) return;
  const active = document.activeElement;
  await nextTick();
  if (!active || active === document.body || !active.isConnected) field.value?.focus();
});

function onFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  chat.attach(Array.from(input.files ?? []));
  input.value = "";
}

/**
 * Files pasted into the reply box (a screenshot, a copied image) are attached as picked ones, named
 * when the clipboard gives them no name of their own. A paste that carries text keeps the browser's
 * own handling: text, links and quick replies go into the box as before.
 */
function onPaste(event: ClipboardEvent): void {
  const data = event.clipboardData;
  if (!data || Array.from(data.types).includes("text/plain")) return;
  const listed = Array.from(data.files);
  const pasted = listed.length ? listed : Array.from(data.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((item): item is File => item !== null);
  if (!pasted.length) return;
  event.preventDefault();
  const at = new Date();
  chat.attach(pasted.map((item, index) => pastedFile(item, at, index)));
}

// Another dialogue: its own draft, no open list, and the cursor in the text field.
watch(() => [chat.ticketId, projects.currentId], async () => {
  closeReplies();
  await nextTick();
  resize();
  field.value?.focus({ preventScroll: true });
}, { immediate: true });

// The draft read from the browser's storage arrives after the dialogue opens: the box takes its height.
watch(() => chat.draft !== null, async (ready) => {
  if (!ready) return;
  await nextTick();
  resize();
});

onUnmounted(closeReplies);
</script>

<template>
  <div class="composer-area">
    <QuickReplies v-if="repliesOpen" :id="listId" :replies="options" :active="active"
      :group="group?.name ?? ''" :loading="loading" :failed="failed" :more="hasMore" :query="query" :button-mode="buttonMode"
      @choose="choose" @hover="active = $event" @back="back" @close="dismiss" @retry="search(query)"
      @search="search" @more="search(query, true)" @keydown="onKeyDown" />
    <SendAttemptNotice v-if="unresolved" ref="attempt-notice" :attempt="unresolved" :sending="chat.sending"
      @retry="retryAttempt" @forget="forgetAttempt" />
    <div v-if="files.length" ref="tray" class="attachment-tray" role="group"
      :aria-label="`Выбранные вложения: ${files.length} из ${MAX_FILES}`">
      <ul class="attachment-list">
        <AttachmentPreview v-for="item in files" :key="fileId(item)" :file="item" :status="status(item)"
          :disabled="!removable(item)" @remove="detach(item)" />
      </ul>
    </div>
    <!-- One line for the whole reply, announced as it moves on: not a notice per file. Kept in the page while
         empty: a live region added with its text is not always announced. -->
    <div class="send-progress" :data-state="queue?.state">
      <p class="m-0" aria-live="polite">{{ progressText }}</p>
      <button v-if="queue?.state === 'running'" type="button" class="quiet min-h-11" @click="chat.stopSending()">Остановить</button>
    </div>
    <form class="composer" @submit.prevent="submit">
      <IconButton
        class="icon-button"
        label="Прикрепить файл"
        :description="`Фото, MP4/MOV, PDF или голосовое OGG/Opus до 20 МБ, до ${MAX_FILES} файлов`"
        :disabled="chat.sending || !chat.draft"
        @click="picker?.click()"
      >
        <Icon name="attach" />
      </IconButton>
      <input ref="picker" type="file" :accept="ACCEPT" multiple hidden @change="onFile" />
      <IconButton :id="repliesButtonId" class="icon-button" label="Готовые ответы" :disabled="chat.sending || !chat.draft"
        :aria-expanded="repliesOpen" :aria-controls="repliesOpen ? listId : undefined" @click="openByButton"><span aria-hidden="true">/</span></IconButton>
      <textarea
        ref="field"
        :value="text"
        rows="1"
        placeholder="Написать ответ…"
        aria-label="Текст ответа"
        aria-autocomplete="list"
        :aria-controls="repliesOpen && !buttonMode ? listId : undefined"
        :aria-activedescendant="repliesOpen && !buttonMode && options.length ? `${listId}-${active}` : undefined"
        :disabled="chat.sending"
        :readonly="!chat.draft"
        :aria-invalid="overLimit || undefined"
        :aria-describedby="overLimit ? limitId : undefined"
        @input="onInput"
        @keydown="onKeyDown"
        @paste="onPaste"
      />
      <!-- aria-disabled, not disabled: a disabled button drops keyboard focus while the request runs. -->
      <button class="primary send" type="submit" aria-label="Отправить" :aria-disabled="chat.sending || undefined">
        <span class="send-label">Отправить</span><Icon name="send" />
      </button>
    </form>
    <!-- Announced when the text crosses the limit or the file changes it, not on every keystroke. -->
    <p :id="limitId" class="composer-limit" aria-live="polite">
      <template v-if="overLimit">
        {{ tooLong(withFiles) }} <span class="composer-limit-count" aria-hidden="true">{{ length }} / {{ limit }}</span>
      </template>
    </p>
    <div class="composer-hint">
      <span><kbd>/</kbd> Готовые ответы</span>
      <span class="compact:hidden"><kbd>Enter</kbd> отправить · <kbd>Shift Enter</kbd> новая строка</span>
    </div>
  </div>
</template>
