<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef } from "vue";
import type { TicketHeading } from "../../api/types";
import { avatarTone, channelName } from "../../lib/format";
import { initials } from "../../lib/initials";
import { useNarrowScreen } from "../../composables/useNarrowScreen";
import { useChatStore } from "../../stores/chat";
import { useFoldersStore } from "../../stores/folders";
import { useTicketsStore } from "../../stores/tickets";
import { useWorkspaceStore } from "../../stores/workspace";
import Icon from "../ui/Icon.vue";
import IconButton from "../ui/IconButton.vue";
import TicketFolderMenu from "../folders/TicketFolderMenu.vue";

// Who the customer is (opens the customer card), the archive state and close or reopen.
// On a narrow screen a back button returns to the list. While a dialogue opens, what the list row or
// the cache already tells shows at once; what nobody knows yet (a dialogue restored before the list
// came) keeps its place as a placeholder, never as a made-up "Клиент" or the wrong action. The dialogue's folder is
// chosen at the right, before close or reopen; where the row is short (a phone, a narrow panel) its button is an icon
// and the folder's name, once the detail says it, follows the channel under the customer's name.
const cardOpen = defineModel<boolean>("cardOpen", { required: true });
const chat = useChatStore();
const workspace = useWorkspaceStore();
const tickets = useTicketsStore();
const folders = useFoldersStore();
const narrow = useNarrowScreen();
// Below this width the header's row has no room for the folder's name beside the customer's (a narrow dialogue
// panel beside the list): the folder is an icon button there too, as on a phone.
const ROOM_FOR_FOLDER_NAME = 640;
const header = useTemplateRef<HTMLElement>("header");
const width = ref(Infinity);
const resize = typeof ResizeObserver === "undefined" ? null
  : new ResizeObserver(([entry]) => { if (entry) width.value = entry.contentRect.width; });
onMounted(() => { if (header.value) resize?.observe(header.value); });
onBeforeUnmount(() => resize?.disconnect());
const compact = computed(() => narrow.value || width.value < ROOM_FOR_FOLDER_NAME);
/** The folder's name for the narrow header, only once the detail says it (never a guessed "no folder"). */
const folderName = computed(() => {
  const id = chat.detail?.folder_id;
  return id ? folders.folders.find((folder) => folder.id === id)?.name ?? "" : "";
});
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
  <header ref="header" class="relative flex min-h-[76px] shrink-0 items-center gap-4 border-b border-border bg-surface px-7 py-3.5 compact:px-4 narrow:min-h-[72px] narrow:gap-2 narrow:px-3 narrow:py-2.5">
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
        <span class="muted flex min-w-0 items-center gap-1 text-xs">
          <!-- Short of room, both give way, neither to nothing. -->
          <span class="min-w-[2rem] truncate">{{ channelName(shown.channel) }}</span>
          <!-- The button beside says the folder to a screen reader; here it is only seen. -->
          <span v-if="compact && folderName" class="flex min-w-[3rem] items-center gap-1" aria-hidden="true">
            <span>·</span><Icon name="folder" class="size-3.5 shrink-0" /><span class="truncate">{{ folderName }}</span>
          </span>
        </span>
      </span>
      <span v-if="pending" class="sr-only">Загружаем данные клиента</span>
      <Icon name="info" class="ml-1 size-4 text-muted narrow:hidden" />
    </button>
    <span v-if="chat.closed" class="pill narrow:hidden">В архиве</span>
    <div class="ml-auto flex shrink-0 items-center gap-2 narrow:gap-1">
      <TicketFolderMenu :compact="compact" />
      <span v-if="statusPending" class="skeleton header-action-skeleton" aria-hidden="true" />
      <!-- aria-disabled, not disabled: a disabled button drops keyboard focus while the request runs. -->
      <button
        v-else
        class="secondary text-accent narrow:px-2.5 narrow:py-2 narrow:text-[.8125rem]"
        type="button"
        :aria-disabled="!chat.detail || chat.lifecycleBusy || undefined"
        @click="chat.toggleClosed()"
      >
        {{ chat.closed ? "Возобновить" : "Завершить" }}
      </button>
    </div>
  </header>
</template>
