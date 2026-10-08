<script setup lang="ts">
import type { TicketItem } from "../../api/types";
import { avatarTone, listTime } from "../../lib/format";
import { initials } from "../../lib/initials";

defineProps<{ ticket: TicketItem }>();
</script>

<template>
  <span class="avatar" :class="avatarTone(ticket.id)" aria-hidden="true">{{ initials(ticket.name) }}</span>
  <span class="min-w-0 flex-1">
    <span class="flex items-baseline gap-2">
      <span class="ticket-name">{{ ticket.name }}</span>
      <time class="ticket-time" :datetime="ticket.time">{{ listTime(ticket.time) }}</time>
    </span>
    <span class="ticket-preview">
      <span class="min-w-0 flex-1 truncate">{{ ticket.preview }}</span>
      <span v-if="ticket.unread" class="count">
        <span class="sr-only">Непрочитанных: </span>{{ ticket.unread > 99 ? "99+" : ticket.unread }}
      </span>
    </span>
  </span>
</template>
