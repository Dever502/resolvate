<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, useTemplateRef, watch } from "vue";
import { useChatStore } from "../../stores/chat";
import { useWorkspaceStore } from "../../stores/workspace";
import MessageItem from "./MessageItem.vue";

// The history of the open dialogue. It follows new messages only when the operator is already at
// the bottom, keeps its place when older messages arrive above, and marks the history read only
// when it can actually be seen (markLatestVisibleAsRead): every way of reaching the end goes there.
const BOTTOM = 100;
const TOP = 40;
const chat = useChatStore();
const workspace = useWorkspaceStore();
const area = useTemplateRef<HTMLElement>("area");
const customer = computed(() => {
  const shown = chat.detail ?? chat.heading;
  return shown.display_name || shown.username || "Клиент";
});
let before = { height: 0, top: 0, atBottom: true };

function atBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM;
}

/**
 * The one place that decides the operator has seen the latest message: the tab is visible, the
 * dialogue is shown (on a phone the list may cover it), its current history has loaded and rendered
 * (not the cached one while it opens), and the view is at the end. Called on every way there: a
 * history change, scrolling, the end of an opening, "to the latest", the tab or the dialogue shown again.
 */
function markLatestVisibleAsRead(): void {
  const element = area.value;
  const last = chat.ordered.at(-1);
  if (!element || !last || chat.opening || document.visibilityState !== "visible") return;
  if (element.getClientRects().length && atBottom(element)) chat.markRead(last.id);
}

/** "To the latest message" for this dialogue, once its current history is loaded and shown. */
function settleJump(): void {
  const request = chat.jump;
  const element = area.value;
  if (!request) return;
  if (request.ticket !== chat.ticketId) {
    chat.jump = null;
    return;
  }
  if (!element || chat.opening || !element.getClientRects().length) return;
  chat.jump = null;
  element.scrollTop = element.scrollHeight;
  markLatestVisibleAsRead();
}

function onScroll(): void {
  const element = area.value;
  if (element && element.scrollTop < TOP && chat.hasOlder) void chat.loadOlder();
  markLatestVisibleAsRead();
}

// Reaching the top or the end during a live refresh or an opening counts afterwards.
watch(() => workspace.refreshing || chat.opening, (busy) => {
  if (busy) return;
  settleJump();
  onScroll();
}, { flush: "post" });

watch(() => chat.jump, settleJump, { flush: "post" });

// Measured before the new messages reach the page…
watch(() => chat.change, () => {
  const element = area.value;
  if (element) before = { height: element.scrollHeight, top: element.scrollTop, atBottom: atBottom(element) };
}, { flush: "pre" });

// …and the scroll is settled after they have.
watch(() => chat.change, ({ kind }) => {
  const element = area.value;
  if (!element) return;
  if (kind === "initial" || (kind === "update" && before.atBottom)) element.scrollTop = element.scrollHeight;
  else if (kind === "older") {
    element.scrollTop = before.top + element.scrollHeight - before.height;
    // The last older page removes its button; a keyboard user who was on it stays in the history.
    if (!document.activeElement || document.activeElement === document.body) element.focus({ preventScroll: true });
  }
  settleJump();
  markLatestVisibleAsRead();
}, { flush: "post" });

function onShown(): void {
  settleJump();
  markLatestVisibleAsRead();
}

// Shown again (on a phone the list gave way to the dialogue) or resized: the end may be in view now.
const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onShown);

onMounted(async () => {
  document.addEventListener("visibilitychange", onShown);
  await nextTick();
  if (!area.value) return;
  area.value.scrollTop = area.value.scrollHeight;
  observer?.observe(area.value);
  // The history may have been rendered before this list was.
  onShown();
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", onShown);
  observer?.disconnect();
});
</script>

<template>
  <div
    ref="area"
    class="messages"
    role="region"
    aria-label="Переписка"
    tabindex="-1"
    @scroll.passive="onScroll"
  >
    <button
      v-if="chat.hasOlder"
      class="quiet mx-auto mb-6 flex text-[.8125rem] text-accent"
      type="button"
      :aria-disabled="chat.loadingOlder || undefined"
      @click="chat.loadOlder()"
    >
      Предыдущие сообщения
    </button>
    <div class="mx-auto flex max-w-[1120px] flex-col gap-5">
      <MessageItem v-for="message in chat.ordered" :key="message.id" :message="message" :customer="customer" />
    </div>
  </div>
</template>
