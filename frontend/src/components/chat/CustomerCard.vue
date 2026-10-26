<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { customerFields } from "../../lib/customerFields";
import { useChatStore } from "../../stores/chat";
import Icon from "../ui/Icon.vue";
import IconButton from "../ui/IconButton.vue";

// Side panel with what is known about the customer. Esc (outside a modal window) closes it and
// returns focus to the customer name in the dialogue header.
const open = defineModel<boolean>("open", { required: true });
const chat = useChatStore();

const fields = computed(() => customerFields(chat.detail, chat.heading));

function close(): void {
  open.value = false;
  document.getElementById("customer-open")?.focus();
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === "Escape" && !document.querySelector('[role="dialog"][data-state="open"]')) close();
}
onMounted(() => document.addEventListener("keydown", onKeyDown));
onUnmounted(() => document.removeEventListener("keydown", onKeyDown));
</script>

<template>
  <aside id="customer-card" class="customer-card" aria-labelledby="customer-card-title">
    <header class="flex items-start justify-between gap-4">
      <h2 id="customer-card-title" class="mt-1.5 text-[1.0625rem]">О клиенте</h2>
      <!-- The 44×44 hit area keeps the 38×36 room of the icon's button, as in ui/ModalDialog.vue. -->
      <IconButton class="quiet -my-1 -mr-1.5 shrink-0" label="Закрыть карточку" @click="close">
        <Icon name="close" />
      </IconButton>
    </header>
    <dl class="m-0">
      <template v-for="[key, value] in fields" :key="key">
        <dt class="mt-6 mb-1.5 text-[.8125rem] text-muted">{{ key }}</dt>
        <dd class="m-0 text-[.9375rem] leading-normal [overflow-wrap:anywhere]">{{ value }}</dd>
      </template>
    </dl>
  </aside>
</template>
