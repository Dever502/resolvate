<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from "vue";
import { ApiError } from "../../api/client";
import { useNotice } from "../../composables/useNotice";
import {
  type Command, type Confirmation, type Receipt, confirmation, fingerprint, fitsNotice, formatProblem, newReceipt,
  outcome, readReceipt, receiptText, removeReceipt, writeReceipt,
} from "../../lib/commandAttempt";
import { useSessionStore } from "../../stores/session";
import { useProjectsStore } from "../../stores/projects";
import { useChatStore } from "../../stores/chat";
import ConfirmDialog from "../ui/ConfirmDialog.vue";
import Icon from "../ui/Icon.vue";

/** One command as it was entered: what a confirmation shows is exactly what is sent, in the dialogue it came from. */
interface Attempt {
  scope: string;
  project: string | null;
  ticket: string | null;
  generation: number;
  command: Command;
  argument: string;
  text: string;
  ask: Confirmation | null;
}
/** A changing command whose outcome is not known: its receipt keeps the key until it is retried or given up. */
interface Unknown {
  scope: string;
  receipt: Receipt | null;
  /** The request in this tab; after a reload only the receipt is left. */
  attempt: Attempt | null;
  reason: string;
}
type Failure = { kind: "format" | "rejected" | "connection" | "local" | "load"; text: string };

const DEADLINE = 60_000;
const props = defineProps<{ text: string; hasFiles: boolean }>();
const emit = defineEmits<{ insert: [value: string]; focus: [] }>();
const root = ref<HTMLElement | null>(null);
const session = useSessionStore();
const projects = useProjectsStore();
const chat = useChatStore();
const id = useId();
const commands = ref<Command[]>([]);
const active = ref(0);
const dismissed = ref(false);
/** The whole pop-up put away (Escape, its close button): the text stays, typing brings it back. */
const closed = ref(false);
const loading = ref(false);
const error = ref<Failure | null>(null);
const result = ref<{ title: string; text: string } | null>(null);
const copied = ref<"" | "done" | "failed">("");
const pending = ref<Attempt | null>(null);
const typed = ref("");
const confirmError = ref("");
const running = ref<Attempt | null>(null);
const preparing = ref(false);
const unknown = ref<Unknown | null>(null);
const abandonOpen = ref(false);
const { notice, success, clear: clearNotice } = useNotice();
const scope = computed(() => `${session.account?.id}:${projects.currentId}:${chat.ticketId}`);
const prefix = computed(() => /^\/[^\s]*$/.test(props.text.trimStart()));
const visible = computed(() => prefix.value && !dismissed.value);
const options = computed(() => commands.value.filter(c => c.name.startsWith(props.text.trimStart().slice(1).toLowerCase())));
const selected = computed(() => commands.value.find(c => c.name === props.text.trim().split(/\s/, 1)[0]?.slice(1)));
const activeId = computed(() => visible.value && options.value[active.value] ? `${id}-${active.value}` : undefined);
const busy = computed(() => Boolean(running.value) || preparing.value);
// Everything the commands show (list, hint, errors, result, an unknown outcome) is one pop-up over the reply box:
// it never takes room in the reply area, so the history keeps its size whatever state the command is in.
const open = computed(() => !closed.value && Boolean(
  (props.text.trimStart().startsWith("/") && (visible.value || selected.value || error.value))
  || result.value || unknown.value || running.value));
const dialogOpen = computed({
  get: () => pending.value !== null,
  // Cancel and Escape drop the attempt; nothing was sent. A confirmed one closes when its answer is in.
  set: (value: boolean) => { if (!value && !running.value) { pending.value = null; typed.value = ""; confirmError.value = ""; } },
});
const unknownLabel = computed(() => {
  const state = unknown.value;
  if (!state) return "";
  if (state.attempt) return state.attempt.command.name === "note" ? "/note" : state.attempt.text;
  return state.receipt ? receiptText(state.receipt) ?? (state.receipt.command ? `/${state.receipt.command}` : "команды") : "команды";
});
const retryable = computed(() => Boolean(unknown.value?.attempt || (unknown.value?.receipt && receiptText(unknown.value.receipt))));
let generation = 0;

// A new error, result or unknown outcome is shown even if the pop-up was put away.
watch([error, result, unknown], ([failure, answer, uncertain]) => { if (failure || answer || uncertain) closed.value = false; });

/** Puts the list away; a hint, an error or a result stays (a tap on the history does not lose a result). */
function dismiss(): void { dismissed.value = true; }
/** Puts the whole pop-up away; a result goes with it, an unknown outcome comes back with the next command. */
function close(): void { dismissed.value = true; closed.value = true; result.value = null; }
function outside(event: PointerEvent): void {
  const target = event.target;
  if (target instanceof Node && !root.value?.parentElement?.contains(target)) dismiss();
}
onMounted(() => document.addEventListener("pointerdown", outside));
onUnmounted(() => { generation++; document.removeEventListener("pointerdown", outside); });

async function load(): Promise<void> {
  const current = ++generation;
  loading.value = true;
  if (error.value?.kind === "load") error.value = null;
  try {
    const found = await session.api<Command[]>("commands", {}, projects.currentId);
    if (current === generation) commands.value = found;
  } catch {
    if (current === generation) error.value = { kind: "load", text: "Не удалось загрузить команды. Повторите запрос." };
  } finally {
    if (current === generation) loading.value = false;
  }
}

/** A receipt left in this dialogue (a reload, another dialogue in between) is an outcome nobody knows yet. */
function recall(): void {
  if (running.value?.scope === scope.value) return;
  try {
    const receipt = readReceipt(sessionStorage, scope.value);
    unknown.value = receipt ? { scope: scope.value, receipt, attempt: null, reason: "Ответ на неё не получен в этой вкладке." } : null;
  } catch {
    unknown.value = { scope: scope.value, receipt: null, attempt: null, reason: "Сохранённый ключ команды не читается." };
  }
}

watch(scope, () => {
  generation++;
  active.value = 0;
  commands.value = [];
  result.value = null;
  error.value = null;
  dismissed.value = false;
  closed.value = false;
  // A confirmation never runs in another dialogue or project.
  pending.value = null;
  recall();
  if (props.text.trimStart().startsWith("/")) void load();
});
watch(() => props.text, (value, old) => {
  active.value = 0;
  dismissed.value = false;
  closed.value = false;
  // An error was about the text as it was; a new command replaces an earlier result.
  if (error.value && error.value.kind !== "load") error.value = null;
  if (value.trimStart().startsWith("/")) result.value = null;
  if (value.trimStart().startsWith("/") && !old?.trimStart().startsWith("/")) void load();
}, { immediate: true });
recall();

function choose(index: number): void {
  const command = options.value[index];
  if (!command || busy.value) return;
  emit("insert", `/${command.name} `);
  dismissed.value = true;
}

function keydown(event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  // Without the list, Escape puts away what the pop-up still shows; the text stays.
  if (!visible.value) {
    if (event.key !== "Escape" || !open.value) return false;
    event.preventDefault(); event.stopPropagation(); close(); return true;
  }
  if (event.key === "Escape") {
    event.preventDefault(); event.stopPropagation(); dismissed.value = true; return true;
  }
  if (["ArrowDown", "ArrowUp"].includes(event.key) && options.value.length) {
    event.preventDefault();
    active.value = (active.value + (event.key === "ArrowDown" ? 1 : -1) + options.value.length) % options.value.length;
    void nextTick(() => document.getElementById(`${id}-${active.value}`)?.scrollIntoView({ block: "nearest" }));
    return true;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault(); choose(active.value); return true;
  }
  return false;
}

function customerName(): string {
  return chat.detail?.display_name || chat.heading.display_name || chat.detail?.username || chat.heading.username || "";
}

/** Enter or «Отправить» with a command in the box: runs it, asks first, or says why not. Never a second request. */
async function execute(): Promise<void> {
  if (busy.value || pending.value || chat.sending || !chat.draft) return;
  error.value = null;
  closed.value = false;
  if (props.hasFiles || chat.attempt) {
    error.value = { kind: "local", text: "Сначала завершите отправку сообщения и уберите вложения. Команды не отправляются клиенту." };
    return;
  }
  const command = selected.value;
  if (!command) { error.value = { kind: "local", text: "Неизвестная или недоступная команда." }; return; }
  const text = props.text.trim();
  const argument = text.slice(command.name.length + 1).trim();
  const problem = formatProblem(command, argument);
  if (problem) { error.value = { kind: "format", text: problem }; return; }
  const attempt: Attempt = {
    scope: scope.value, project: projects.currentId, ticket: chat.ticketId, generation: session.generation,
    command, argument, text, ask: null,
  };
  if (!command.mutation) { await run(attempt, crypto.randomUUID()); return; }
  let stored: Receipt | null;
  try {
    stored = readReceipt(sessionStorage, attempt.scope);
  } catch {
    error.value = { kind: "local", text: "Не удалось прочитать ключ предыдущей команды. Выполнение отменено для защиты от повторов." };
    return;
  }
  if (stored) {
    // The same command as the one whose outcome is unknown: its retry, under its key, needs no new confirmation.
    preparing.value = true;
    let same = false;
    try { same = (await fingerprint(text)) === stored.fingerprint; } finally { preparing.value = false; }
    if (scope.value !== attempt.scope) return;
    if (same) { await run(attempt, stored.key, stored); return; }
    unknown.value = { scope: attempt.scope, receipt: stored, attempt: unknown.value?.attempt ?? null, reason: unknown.value?.reason ?? "Ответ на неё не получен." };
    error.value = { kind: "local", text: "Новую изменяющую команду нельзя выполнить, пока результат предыдущей неизвестен: повторите её или откажитесь от повтора." };
    return;
  }
  attempt.ask = confirmation(command.name, argument, customerName(), projects.current?.name ?? "");
  if (attempt.ask) { pending.value = attempt; return; }
  await start(attempt);
}

/** The confirmation's action: once, in the dialogue and project the command was entered in. */
async function confirm(): Promise<void> {
  const attempt = pending.value;
  if (!attempt || busy.value) return;
  if (attempt.ask?.typeToConfirm !== undefined && typed.value.trim() !== attempt.ask.typeToConfirm) {
    confirmError.value = "Введите название проекта точно так, как оно написано.";
    return;
  }
  if (attempt.scope !== scope.value || attempt.generation !== session.generation) { pending.value = null; return; }
  await start(attempt);
  pending.value = null;
  typed.value = "";
  confirmError.value = "";
}

/** A confirmed changing command: its key is kept before the request leaves, or nothing is sent. */
async function start(attempt: Attempt): Promise<void> {
  preparing.value = true;
  let receipt: Receipt;
  try {
    receipt = newReceipt(attempt.command.name, attempt.argument, await fingerprint(attempt.text));
    writeReceipt(sessionStorage, attempt.scope, receipt);
  } catch {
    error.value = { kind: "local", text: "Не удалось сохранить ключ команды. Выполнение отменено для защиты от повторов." };
    return;
  } finally {
    preparing.value = false;
  }
  if (attempt.scope !== scope.value || attempt.generation !== session.generation) {
    removeReceipt(sessionStorage, attempt.scope, receipt.key);
    return;
  }
  await run(attempt, receipt.key, receipt);
}

/** Sends the command and settles its receipt by what the answer says (lib/commandAttempt.ts). */
async function run(attempt: Attempt, key: string, receipt?: Receipt): Promise<void> {
  running.value = attempt;
  chat.sending = true;
  dismissed.value = true;
  closed.value = false;
  error.value = null;
  result.value = null;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), DEADLINE);
  let answer: { status: string; message: string } | null = null;
  let failure: unknown;
  try {
    answer = await session.api<{ status: string; message: string }>(
      `tickets/${attempt.ticket}/commands/${attempt.command.name}`,
      { method: "POST", key, data: { arguments: attempt.argument }, signal: controller.signal }, attempt.project,
    );
  } catch (cause) {
    failure = cause ?? new Error("failed");
  } finally {
    clearTimeout(deadline);
    running.value = null;
    if (session.generation === attempt.generation) chat.sending = false;
  }
  const settled = outcome(answer, failure);
  const here = scope.value === attempt.scope && session.generation === attempt.generation;
  if (receipt && settled !== "unknown") {
    try { removeReceipt(sessionStorage, attempt.scope, receipt.key); } catch { /* left: it shows as unknown next time, never runs twice */ }
  }
  if (!here) return;
  if (settled !== "unknown" && unknown.value?.scope === attempt.scope && unknown.value.receipt?.key === key) {
    unknown.value = null;
  }
  if (settled === "completed" && answer) {
    // Done: the command leaves the box, unless the operator has typed something else meanwhile.
    if (props.text.trim() === attempt.text) emit("insert", "");
    if (attempt.command.mutation && fitsNotice(answer.message)) {
      result.value = null;
      success(answer.message);
    } else {
      result.value = { title: `Результат /${attempt.command.name}`, text: answer.message };
      copied.value = "";
    }
    return;
  }
  const reason = controller.signal.aborted ? "Ответ сервера не получен за минуту."
    : failure instanceof ApiError ? failure.message
      : answer?.message || "Ответ сервера не получен.";
  if (settled === "rejected") { error.value = { kind: "rejected", text: reason }; return; }
  if (!attempt.command.mutation) {
    error.value = { kind: "connection", text: `${reason} Команда только читает данные: её можно повторить.` };
    return;
  }
  unknown.value = { scope: attempt.scope, receipt: receipt ?? null, attempt, reason };
}

/** The unknown command again: the same request under the same key, which never runs the action a second time. */
async function retry(): Promise<void> {
  const state = unknown.value;
  if (!state?.receipt || busy.value || chat.sending) return;
  let attempt = state.attempt;
  if (!attempt) {
    const text = receiptText(state.receipt);
    const command = commands.value.find(item => item.name === state.receipt?.command)
      ?? { name: state.receipt.command ?? "", description: "", arguments: "", mutation: true };
    if (!text || !command.name) return;
    attempt = {
      scope: scope.value, project: projects.currentId, ticket: chat.ticketId, generation: session.generation,
      command, argument: state.receipt.arguments ?? "", text, ask: null,
    };
  }
  if (attempt.scope !== scope.value) return;
  await run({ ...attempt, generation: session.generation }, state.receipt.key, state.receipt);
}

/** Gives up the unknown command: only its local key goes; its real outcome stays unknown. */
function abandon(): void {
  try { removeReceipt(sessionStorage, scope.value); } catch { error.value = { kind: "local", text: "Не удалось удалить ключ команды." }; return; }
  unknown.value = null;
  abandonOpen.value = false;
  emit("focus");
}

async function copy(): Promise<void> {
  if (!result.value) return;
  try { await navigator.clipboard.writeText(result.value.text); copied.value = "done"; } catch { copied.value = "failed"; }
}

function afterDialog(event: Event): void {
  event.preventDefault();
  emit("focus");
}

defineExpose({ execute, keydown, dismiss, close, visible, activeId, id });
</script>

<template>
  <div ref="root" class="command-layer">
    <div v-if="open" class="reply-options command-options" :aria-busy="busy || undefined"
      @keydown.esc.prevent.stop="close(); emit('focus')">
      <!-- Positioned over the reply box (.reply-options, as the quick replies): nothing of it is in the reply area's flow. -->
      <div class="reply-options-head">
        <span class="min-w-0 flex-1 truncate">Команды — отдельно от сообщений</span>
        <button type="button" class="quiet -ml-2 min-h-11 min-w-11" aria-label="Закрыть команды"
          @click="close(); emit('focus')"><Icon name="close" /></button>
      </div>
      <!-- One scrolling body: a long list, error or result scrolls inside the pop-up, its buttons stay below. -->
      <div class="reply-options-body">
        <template v-if="visible">
          <p v-if="loading" class="command-status" role="status">Загрузка команд…</p>
          <div :id="id" role="listbox" aria-label="Доступные команды">
            <div v-for="(command, index) in options" :id="`${id}-${index}`" :key="command.name"
              class="reply-option" role="option" :aria-selected="active === index"
              @mousedown.prevent @pointermove="active = index" @click="choose(index)">
              <strong>/{{ command.name }}</strong>{{ command.arguments ? ` ${command.arguments}` : "" }} — {{ command.description }}
            </div>
          </div>
          <p v-if="!loading && !options.length" class="command-status">Нет доступных команд</p>
        </template>
        <p v-if="selected && text.trimStart().startsWith('/')" class="command-hint">/{{ selected.name }}{{ selected.arguments ? ` ${selected.arguments}` : "" }} — {{ selected.description }}. Отправка выполнит команду, не сообщение клиенту.</p>
        <p v-if="running" class="command-status">Выполняется {{ running.command.name === "note" ? "/note" : running.text }}…</p>
        <!-- A format, a refusal, a lost answer to a reading and a local problem look different. -->
        <p v-if="error" role="alert" class="command-alert" :data-kind="error.kind">{{ error.text }}</p>
        <section v-if="unknown" class="command-unknown" role="alert" aria-labelledby="command-unknown-title">
          <p id="command-unknown-title" class="command-unknown-title">Результат {{ unknownLabel }} неизвестен</p>
          <p class="m-0">{{ unknown.reason }} Команда могла быть выполнена. «Повторить запрос» отправит тот же запрос с прежним ключом: сервер вернёт сохранённый результат или снова сообщит, что он неизвестен, — второй раз команда не выполнится.</p>
          <p v-if="unknown.receipt && !retryable" class="m-0">Чтобы повторить, верните в поле ответа прежний текст команды и нажмите Enter.</p>
        </section>
        <p v-if="result" class="command-result-title">{{ result.title }}</p>
        <!-- In the page while the pop-up is open, so the result is announced when it comes. -->
        <p role="status" :tabindex="result ? 0 : undefined" :aria-label="result ? 'Результат команды' : undefined"
          :data-filled="result ? '' : undefined" class="command-result">{{ result?.text }}</p>
      </div>
      <div v-if="result || unknown || error?.kind === 'load'" class="command-actions">
        <button v-if="error?.kind === 'load'" type="button" class="quiet min-h-11" @click="load">Повторить загрузку команд</button>
        <template v-if="unknown">
          <button v-if="retryable" type="button" class="quiet min-h-11" :disabled="busy" @click="retry">Повторить запрос</button>
          <button type="button" class="quiet min-h-11" :disabled="busy" @click="abandonOpen = true">Отказаться от повтора</button>
        </template>
        <button v-if="result" type="button" class="quiet min-h-11" @click="copy">
          {{ copied === "done" ? "Скопировано" : copied === "failed" ? "Не удалось скопировать" : "Скопировать" }}
        </button>
      </div>
    </div>
    <!-- A finished change says so briefly over the reply box and goes by itself; it takes no room. A live region
         kept in the page (not a second "status" of the page), so the notice is read out when it comes. -->
    <div class="command-toast-region" aria-live="polite">
      <Transition name="catalog-toast">
        <p v-if="notice?.kind === 'success'" :key="notice.id" class="catalog-toast">
          <Icon name="check" class="size-4 text-success" />{{ notice.text }}
        </p>
      </Transition>
    </div>
    <!-- Mounted all the time: it closes by its state, so the focus goes back to the reply box. -->
    <ConfirmDialog
      v-model:open="dialogOpen"
      :title="pending?.ask?.title ?? ''"
      :description="pending?.ask?.description ?? ''"
      :confirm-label="pending?.ask?.confirmLabel ?? ''"
      :danger="pending?.ask?.danger ?? false"
      :busy="busy"
      :error="confirmError"
      @confirm="confirm"
      @close-auto-focus="afterDialog"
    >
      <label v-if="pending?.ask?.typeToConfirm !== undefined" class="field-label mt-4">
        Название проекта
        <input v-model="typed" class="field-input mt-2" autocomplete="off" spellcheck="false" />
      </label>
    </ConfirmDialog>
    <ConfirmDialog
      v-model:open="abandonOpen"
      title="Отказаться от повтора?"
      :description="`Результат ${unknownLabel} останется неизвестным: команда могла быть выполнена. После отказа новая изменяющая команда может повторить то же действие.`"
      confirm-label="Отказаться от повтора"
      cancel-label="Не отказываться"
      danger
      @confirm="abandon"
      @close-auto-focus="afterDialog"
    />
  </div>
</template>
