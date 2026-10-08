<script setup lang="ts">
import { computed } from "vue";
import { avatarTone, channelName } from "../../lib/format";
import { initials } from "../../lib/initials";
import { useChatStore } from "../../stores/chat";
import { useWorkspaceStore } from "../../stores/workspace";
import Icon from "../ui/Icon.vue";
import IconButton from "../ui/IconButton.vue";

// Who the customer is (opens the customer card), the archive state and close or reopen.
// On a narrow screen a back button returns to the list.
const cardOpen = defineModel<boolean>("cardOpen", { required: true });
const chat = useChatStore();
const workspace = useWorkspaceStore();
const shown = computed(() => chat.detail ?? chat.heading);
const name = computed(() => shown.value.display_name || shown.value.username || "Клиент");
</script>

<template>
  <header class="flex min-h-[76px] shrink-0 items-center gap-4 border-b border-border bg-surface px-7 py-3.5 compact:px-4 narrow:min-h-[72px] narrow:gap-2 narrow:px-3 narrow:py-2.5">
    <IconButton class="quiet -ml-1 hidden min-h-11 min-w-11 p-2 narrow:inline-flex" label="К списку диалогов" @click="workspace.dialogueOpen = false">
      <Icon name="back" />
    </IconButton>
    <button
      id="customer-open"
      class="customer-title"
      type="button"
      :aria-expanded="cardOpen"
      aria-controls="customer-card"
      title="Открыть карточку клиента"
      @click="cardOpen = !cardOpen"
    >
      <span class="avatar narrow:hidden" :class="chat.ticketId ? avatarTone(chat.ticketId) : ''" aria-hidden="true">{{ initials(name) }}</span>
      <span class="block min-w-0">
        <strong class="mb-0.5 block truncate text-lg font-[650] narrow:max-w-[42vw] narrow:text-[.9375rem]">{{ name }}</strong>
        <span class="muted block text-xs">{{ channelName(shown.channel) }}</span>
      </span>
      <Icon name="info" class="ml-1 size-4 text-muted narrow:hidden" />
    </button>
    <span v-if="chat.closed" class="pill narrow:hidden">В архиве</span>
    <!-- aria-disabled, not disabled: a disabled button drops keyboard focus while the request runs. -->
    <button
      class="secondary ml-auto text-accent narrow:px-2.5 narrow:py-2 narrow:text-[.8125rem]"
      type="button"
      :aria-disabled="!chat.detail || chat.lifecycleBusy || undefined"
      @click="chat.toggleClosed()"
    >
      {{ chat.closed ? "Возобновить" : "Завершить" }}
    </button>
  </header>
</template>
