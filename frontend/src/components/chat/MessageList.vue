<script setup lang="ts">
import { computed, nextTick, onMounted, useTemplateRef, watch } from "vue";
import { useChatStore } from "../../stores/chat";
import { useWorkspaceStore } from "../../stores/workspace";
import MessageItem from "./MessageItem.vue";

// The history of the open dialogue. It follows new messages only when the operator is already at
// the bottom, keeps its place when older messages arrive above, and marks the history read only
// when it can actually be seen: the tab is visible, the dialogue is shown, the view is at the end.
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

function onScroll(): void {
  const element = area.value;
  if (element && element.scrollTop < TOP && chat.hasOlder) void chat.loadOlder();
}

// Reaching the top during a live refresh or an opening loads nothing then: check again afterwards.
watch(() => workspace.refreshing || chat.opening, (busy) => {
  if (!busy) onScroll();
});

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
  const last = chat.ordered.at(-1);
  if (last && kind !== "older" && (kind === "initial" || before.atBottom)
    && !document.hidden && element.getClientRects().length) {
    chat.markRead(last.id);
  }
}, { flush: "post" });

onMounted(async () => {
  await nextTick();
  if (area.value) area.value.scrollTop = area.value.scrollHeight;
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
