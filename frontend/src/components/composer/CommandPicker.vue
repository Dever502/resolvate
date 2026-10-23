<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from "vue";
import { useSessionStore } from "../../stores/session";
import { useProjectsStore } from "../../stores/projects";
import { useChatStore } from "../../stores/chat";

type Command = { name: string; description: string; arguments: string; mutation: boolean };
type Receipt = { fingerprint: string; key: string };
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
const loading = ref(false);
const error = ref("");
const result = ref("");
const busy = ref(false);
const scope = computed(() => `${session.account?.id}:${projects.currentId}:${chat.ticketId}`);
const prefix = computed(() => /^\/[^\s]*$/.test(props.text.trimStart()));
const visible = computed(() => prefix.value && !dismissed.value);
const options = computed(() => commands.value.filter(c => c.name.startsWith(props.text.trimStart().slice(1).toLowerCase())));
const selected = computed(() => commands.value.find(c => c.name === props.text.trim().split(/\s/, 1)[0]?.slice(1)));
const activeId = computed(() => visible.value && options.value[active.value] ? `${id}-${active.value}` : undefined);
let generation = 0;

function dismiss(): void { dismissed.value = true; }
function outside(event: PointerEvent): void {
  const target = event.target;
  if (target instanceof Node && !root.value?.parentElement?.contains(target)) dismiss();
}
onMounted(() => document.addEventListener("pointerdown", outside));
onUnmounted(() => { generation++; document.removeEventListener("pointerdown", outside); });

async function load(): Promise<void> {
  const current = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const found = await session.api<Command[]>("commands", {}, projects.currentId);
    if (current === generation) commands.value = found;
  } catch {
    if (current === generation) error.value = "Не удалось загрузить команды. Повторите запрос.";
  } finally {
    if (current === generation) loading.value = false;
  }
}

watch(scope, () => {
  generation++;
  active.value = 0;
  commands.value = [];
  result.value = "";
  error.value = "";
  dismissed.value = false;
  if (props.text.trimStart().startsWith("/")) void load();
});
watch(() => props.text, (value, old) => {
  active.value = 0;
  dismissed.value = false;
  result.value = "";
  if (value.trimStart().startsWith("/") && !old?.trimStart().startsWith("/")) void load();
}, { immediate: true });

function choose(index: number): void {
  const command = options.value[index];
  if (!command || busy.value) return;
  emit("insert", `/${command.name} `);
  dismissed.value = true;
}

function keydown(event: KeyboardEvent): boolean {
  if (!visible.value || event.isComposing || event.keyCode === 229) return false;
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

async function execute(): Promise<void> {
  if (busy.value || chat.sending || !chat.draft) return;
  if (props.hasFiles || chat.attempt) { error.value = "Сначала завершите отправку сообщения и уберите вложения. Команды не отправляются клиенту."; return; }
  const command = selected.value;
  if (!command) { error.value = "Неизвестная или недоступная команда."; return; }
  const normalized = props.text.trim();
  const argument = normalized.slice(command.name.length + 1).trim();
  if ((command.name === "gift" && (!/^[0-9]{1,4}$/.test(argument) || Number(argument) < 1))
      || (command.name === "note" && !argument)
      || (command.name === "resolvepanel" && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\s+(applied|not_applied)$/i.test(argument))
      || (!["gift", "note", "resolvepanel"].includes(command.name) && argument)) {
    error.value = `Формат: /${command.name} ${command.arguments}`; return;
  }
  const storageKey = `resolvate.command:${scope.value}`;
  const current = scope.value;
  const project = projects.currentId;
  const ticket = chat.ticketId;
  const sessionGeneration = session.generation;
  let receipt: Receipt;
  // Persist BEFORE POST: a reload or a lost response reuses the same key. Keep
  // the receipt after success as well, until the operator explicitly starts anew.
  busy.value = true;
  try {
    if (!command.mutation) receipt = { fingerprint: "", key: crypto.randomUUID() };
    else {
      // Keep only a digest, never note text or customer data in sessionStorage.
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
      const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      const saved = sessionStorage.getItem(storageKey);
      const parsed = saved ? JSON.parse(saved) as Receipt : null;
      if (parsed && parsed.fingerprint !== fingerprint) {
        error.value = "Есть предыдущая команда. Проверьте её результат и нажмите «Новая команда»."; return;
      }
      receipt = parsed ?? { fingerprint, key: crypto.randomUUID() };
      if (typeof receipt.key !== "string" || typeof receipt.fingerprint !== "string") throw new Error();
      sessionStorage.setItem(storageKey, JSON.stringify(receipt));
    }
  } catch { error.value = "Не удалось сохранить ключ команды. Выполнение отменено для защиты от повторов."; return; }
  finally { busy.value = false; }
  if (scope.value !== current || session.generation !== sessionGeneration) return;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 60000);
  busy.value = true;
  chat.sending = true;
  error.value = "";
  dismissed.value = true;
  try {
    const response = await session.api<{ status: string; message: string }>(
      `tickets/${ticket}/commands/${command.name}`,
      { method: "POST", key: receipt.key, data: { arguments: argument }, signal: controller.signal }, project,
    );
    if (scope.value === current) result.value = response.message;
  } catch (cause) {
    const reason = controller.signal.aborted ? "Ответ не получен за минуту." : cause instanceof Error ? cause.message : "Нет ответа сервера.";
    if (scope.value === current) error.value = `${reason} Повторная отправка использует прежний ключ; не начинайте новую операцию, пока не проверили результат.`;
  } finally {
    clearTimeout(deadline);
    busy.value = false;
    if (session.generation === sessionGeneration) chat.sending = false;
  }
}

function fresh(): void {
  if (busy.value || !window.confirm("Результат предыдущей команды проверен? Новая команда может выполнить действие повторно.")) return;
  try { sessionStorage.removeItem(`resolvate.command:${scope.value}`); }
  catch { error.value = "Не удалось очистить ключ команды."; return; }
  result.value = ""; error.value = ""; emit("insert", "/");
}

defineExpose({ execute, keydown, dismiss, visible, activeId, id });
</script>

<template>
  <div v-if="text.trimStart().startsWith('/')" ref="root" class="mb-2"
    @keydown.esc.prevent.stop="dismiss(); emit('focus')">
    <div v-if="visible" class="reply-options">
      <div class="reply-options-head">
        <span class="min-w-0 flex-1">Команды — отдельно от сообщений</span>
        <button type="button" class="quiet min-h-11 min-w-11" aria-label="Закрыть команды"
          @click="dismiss(); emit('focus')">×</button>
      </div>
      <p v-if="loading" role="status">Загрузка команд…</p>
      <div :id="id" class="reply-options-body" role="listbox" aria-label="Доступные команды">
        <div v-for="(command, index) in options" :id="`${id}-${index}`" :key="command.name"
          class="reply-option" role="option" :aria-selected="active === index"
          @mousedown.prevent @pointermove="active = index" @click="choose(index)">
          <strong>/{{ command.name }}</strong> {{ command.arguments }} — {{ command.description }}
        </div>
        <p v-if="!loading && !options.length">Нет доступных команд</p>
      </div>
      <button v-if="error" type="button" class="quiet min-h-11" @click="load">Повторить загрузку команд</button>
    </div>
    <p v-if="selected" class="muted">/{{ selected.name }} {{ selected.arguments }} — {{ selected.description }}. Отправка выполнит команду, не сообщение клиенту.</p>
    <p v-if="error" role="alert" class="notice">{{ error }}</p>
    <p v-if="result" role="status" tabindex="0" aria-label="Результат команды"
      class="max-h-[30dvh] overflow-auto whitespace-pre-wrap break-words">{{ result }}</p>
    <button v-if="result || error" type="button" class="quiet min-h-11" :disabled="busy" @click="fresh">Новая команда</button>
  </div>
</template>
