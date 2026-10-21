<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, useTemplateRef, watch } from "vue";
import { useChatStore } from "../../stores/chat";
import { useWorkspaceStore } from "../../stores/workspace";
import MessageItem from "./MessageItem.vue";

// The history of the open dialogue. It follows new messages only when the operator is already at
// the bottom, keeps its place when older messages arrive above, and marks the history read only
// when it can actually be seen (markLatestVisibleAsRead): every way of reaching the end goes there.
// The history also grows by itself (a photo or video sized late, a font): the operator who was at the
// end stays there, one reading above keeps the message at the top of the view where it was.
const BOTTOM = 100;
const TOP = 40;
const chat = useChatStore();
const workspace = useWorkspaceStore();
const area = useTemplateRef<HTMLElement>("area");
const content = useTemplateRef<HTMLElement>("content");
const customer = computed(() => {
  const shown = chat.detail ?? chat.heading;
  return shown.display_name || shown.username || "Клиент";
});
let before = { height: 0, top: 0, atBottom: true };
/**
 * Where the operator is, as of the last scroll (theirs or ours): at the end, or reading above it with
 * the first message in view and its distance from the top of the view; `top` is the scroll it was noted at.
 */
let place: { atBottom: boolean; anchor: Element | null; offset: number; top: number } = { atBottom: true, anchor: null, offset: 0, top: 0 };

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

/** Notes the operator's place: at the end, or the first message in view and where it is. */
function remember(): void {
  const element = area.value;
  if (!element) return;
  place = { atBottom: atBottom(element), anchor: null, offset: 0, top: element.scrollTop };
  if (place.atBottom || !content.value) return;
  const top = element.getBoundingClientRect().top;
  for (const message of content.value.children) {
    const box = message.getBoundingClientRect();
    if (box.bottom > top) {
      place = { atBottom: false, anchor: message, offset: box.top - top, top: element.scrollTop };
      return;
    }
  }
}

/**
 * The noted place, noted anew if the history has scrolled since: its scroll event may still be to come
 * (some engines observe sizes first).
 */
function noted(): typeof place {
  const element = area.value;
  if (element && Math.abs(element.scrollTop - place.top) >= 1) remember();
  return place;
}

/**
 * The history or its content changed size without a scroll (media sized as it loads, messages laid out
 * again, a taller reply box): the operator at the end stays at the end; one reading above keeps the
 * noted message where it was in the view. Messages added or loaded above are settled by the history
 * change itself.
 */
function keepPlace(): void {
  const element = area.value;
  if (!element || !element.getClientRects().length) return;
  // Scrolled since the place was noted: the place is the one scrolled to, nothing to keep.
  if (Math.abs(element.scrollTop - place.top) >= 1) {
    remember();
    return;
  }
  if (place.atBottom) {
    element.scrollTop = element.scrollHeight;
  } else if (place.anchor?.isConnected) {
    const shift = place.anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - place.offset;
    if (Math.abs(shift) >= 1) element.scrollTop += shift;
  }
  remember();
}

function onScroll(): void {
  const element = area.value;
  remember();
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
  // At the end also when a resize has not been observed yet (a reply box grown in this same frame).
  if (element) before = { height: element.scrollHeight, top: element.scrollTop, atBottom: atBottom(element) || noted().atBottom };
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
  // Another dialogue, or messages added: the place is noted anew, not carried over from before them.
  remember();
  settleJump();
  markLatestVisibleAsRead();
}, { flush: "post" });

function onShown(): void {
  settleJump();
  markLatestVisibleAsRead();
}

// Shown again (on a phone the list gave way to the dialogue) or resized (a growing reply box, a turned
// phone): the place is kept as for content that changes size, and the end may be in view now.
const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
  keepPlace();
  onShown();
});
// The history's own size, apart from the view's: content that grows or shrinks by itself.
const growth = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(keepPlace);

onMounted(async () => {
  document.addEventListener("visibilitychange", onShown);
  await nextTick();
  if (!area.value) return;
  area.value.scrollTop = area.value.scrollHeight;
  observer?.observe(area.value);
  if (content.value) growth?.observe(content.value);
  remember();
  // The history may have been rendered before this list was.
  onShown();
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", onShown);
  observer?.disconnect();
  growth?.disconnect();
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
    <div ref="content" class="mx-auto flex max-w-[1120px] flex-col gap-5">
      <MessageItem v-for="message in chat.ordered" :key="message.id" :message="message" :customer="customer" />
    </div>
  </div>
</template>
