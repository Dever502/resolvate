<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { channelName } from "../../lib/format";
import { useChatStore } from "../../stores/chat";
import Icon from "../ui/Icon.vue";
import IconButton from "../ui/IconButton.vue";

// Side panel with what is known about the customer. Esc (outside a modal window) closes it and
// returns focus to the customer name in the dialogue header.
const open = defineModel<boolean>("open", { required: true });
const chat = useChatStore();

const fields = computed(() => {
  const detail = chat.detail ?? chat.heading;
  const all: [string, string | null | undefined][] = [
    ["Имя", detail.display_name],
    ["Канал", detail.channel ? channelName(detail.channel) : null],
    ["Username", detail.username],
    ["Email", chat.detail?.email],
    ["Идентификатор", chat.detail?.identity_value],
    ["Remnawave ID", chat.detail?.remnawave_user_uuid],
    ["Первое обращение", chat.detail?.created_at ? new Date(chat.detail.created_at).toLocaleString("ru") : null],
  ];
  return all.filter((field): field is [string, string] => Boolean(field[1]));
});

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
      <IconButton class="quiet min-w-9 shrink-0" label="Закрыть карточку" @click="close">
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
