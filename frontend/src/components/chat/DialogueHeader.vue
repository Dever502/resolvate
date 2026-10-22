<script setup lang="ts">
import { computed } from "vue";
import type { TicketHeading } from "../../api/types";
import { avatarTone, channelName } from "../../lib/format";
import { initials } from "../../lib/initials";
import { useChatStore } from "../../stores/chat";
import { useTicketsStore } from "../../stores/tickets";
import { useWorkspaceStore } from "../../stores/workspace";
import Icon from "../ui/Icon.vue";
import IconButton from "../ui/IconButton.vue";

// Who the customer is (opens the customer card), the archive state and close or reopen.
// On a narrow screen a back button returns to the list. While a dialogue opens, what the list row or
// the cache already tells shows at once; what nobody knows yet (a dialogue restored before the list
// came) keeps its place as a placeholder, never as a made-up "Клиент" or the wrong action.
const cardOpen = defineModel<boolean>("cardOpen", { required: true });
const chat = useChatStore();
const workspace = useWorkspaceStore();
const tickets = useTicketsStore();
/** The detail, else what the dialogue opened with, else its list row once the list has it (a restored dialogue). */
const shown = computed<TicketHeading>(() => {
  if (chat.detail) return chat.detail;
  const row = chat.ticketId ? tickets.items.get(chat.ticketId) : undefined;
  if (chat.heading.display_name || chat.heading.username || !row) return chat.heading;
  return { display_name: row.name, channel: row.channel, status: row.status };
});
const name = computed(() => shown.value.display_name || shown.value.username || "Клиент");
const nameKnown = computed(() => Boolean(chat.detail || shown.value.display_name || shown.value.username));
/** Opening, and the customer's name not known yet. A failed opening shows what there is, not a placeholder. */
const pending = computed(() => chat.opening && !nameKnown.value);
/** Close or reopen depends on the status: until it is known the button keeps its place as a placeholder. */
const statusPending = computed(() => chat.opening && !chat.detail && !shown.value.status);
</script>

<template>
  <header class="flex min-h-[76px] shrink-0 items-center gap-4 border-b border-border bg-surface px-7 py-3.5 compact:px-4 narrow:min-h-[72px] narrow:gap-2 narrow:px-3 narrow:py-2.5">
    <!-- A frequent touch action with room in the header: 48×48 for a coarse pointer (app.css, .dialogue-back). -->
    <IconButton class="quiet dialogue-back -ml-1 hidden p-2 narrow:inline-flex" label="К списку диалогов" @click="workspace.dialogueOpen = false">
      <Icon name="back" />
    </IconButton>
    <button
      id="customer-open"
      class="customer-title"
      type="button"
      :aria-expanded="cardOpen"
      aria-controls="customer-card"
      :aria-busy="pending || undefined"
      title="Открыть карточку клиента"
      @click="cardOpen = !cardOpen"
    >
      <span v-if="pending" class="skeleton avatar narrow:hidden" aria-hidden="true" />
      <span v-else class="avatar narrow:hidden" :class="chat.ticketId ? avatarTone(chat.ticketId) : ''" aria-hidden="true">{{ initials(name) }}</span>
      <span v-if="pending" class="block min-w-0" aria-hidden="true">
        <span class="skeleton mb-1.5 h-4 w-40 max-w-[42vw]" />
        <span class="skeleton h-3 w-20" />
      </span>
      <span v-else class="block min-w-0">
        <strong class="mb-0.5 block truncate text-lg font-[650] narrow:max-w-[42vw] narrow:text-[.9375rem]">{{ name }}</strong>
        <span class="muted block text-xs">{{ channelName(shown.channel) }}</span>
      </span>
      <span v-if="pending" class="sr-only">Загружаем данные клиента</span>
      <Icon name="info" class="ml-1 size-4 text-muted narrow:hidden" />
    </button>
    <span v-if="chat.closed" class="pill narrow:hidden">В архиве</span>
    <span v-if="statusPending" class="skeleton header-action-skeleton ml-auto" aria-hidden="true" />
    <!-- aria-disabled, not disabled: a disabled button drops keyboard focus while the request runs. -->
    <button
      v-else
      class="secondary ml-auto text-accent narrow:px-2.5 narrow:py-2 narrow:text-[.8125rem]"
      type="button"
      :aria-disabled="!chat.detail || chat.lifecycleBusy || undefined"
      @click="chat.toggleClosed()"
    >
      {{ chat.closed ? "Возобновить" : "Завершить" }}
    </button>
  </header>
</template>
