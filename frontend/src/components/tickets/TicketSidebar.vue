<script setup lang="ts">
import { TabsContent, TabsRoot } from "reka-ui";
import { computed, onMounted, onUnmounted, useTemplateRef } from "vue";
import { useProjectsStore } from "../../stores/projects";
import { useTicketsStore } from "../../stores/tickets";
import { useWorkspaceStore } from "../../stores/workspace";
import AccountFooter from "../account/AccountFooter.vue";
import FolderTabs, { ALL } from "../folders/FolderTabs.vue";
import Icon from "../ui/Icon.vue";
import IconButton from "../ui/IconButton.vue";
import TicketList from "./TicketList.vue";

// The list column: active dialogues or the archive, search, folder tabs, pages of 50, account.
const tickets = useTicketsStore();
const projects = useProjectsStore();
const workspace = useWorkspaceStore();
const heading = useTemplateRef<HTMLElement>("heading");
const tab = computed(() => tickets.folderFilter || ALL);
let searchTimer: ReturnType<typeof setTimeout> | undefined;

// The workspace replaces the sign-in form, which held focus: without this it would fall to the page.
onMounted(() => heading.value?.focus());
onUnmounted(() => clearTimeout(searchTimer));

function sync(): void {
  tickets.sync().catch((error: unknown) => workspace.fail(error));
}

function search(event: Event): void {
  tickets.setQuery((event.target as HTMLInputElement).value);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(sync, 250);
}

function toggleArchive(): void {
  tickets.setArchived(!tickets.archived);
  sync();
}

function chooseFolder(value: string | number): void {
  tickets.setFolder(value === ALL ? "" : String(value));
  sync();
}

function more(): void {
  tickets.more();
  sync();
}
</script>

<template>
  <aside
    id="ticket-sidebar"
    class="flex w-[clamp(var(--sidebar-width),var(--sidebar-preferred-width,var(--sidebar-width)),max(var(--sidebar-width),33.333333vw))] min-w-[16.875rem] shrink-0 flex-col border-r border-border bg-surface narrow:w-full narrow:min-w-0 narrow:flex-1"
    aria-label="Список диалогов"
  >
    <!-- Narrow screens hide the conversation panel, so its notices show above the list there. -->
    <p v-if="workspace.notice" class="notice hidden narrow:block" role="alert">{{ workspace.notice }}</p>
    <header class="flex items-center justify-between gap-3 pt-6 pr-4 pb-1.5 pl-5 narrow:pt-5">
      <h1 ref="heading" class="m-0 text-[1.625rem] font-[650] tracking-[-.025em] outline-none" tabindex="-1">
        {{ tickets.archived ? "Архив" : "Диалоги" }}
      </h1>
      <IconButton
        class="quiet min-h-11 min-w-11 shrink-0 p-2"
        :label="tickets.archived ? 'К активным диалогам' : 'Открыть архив'"
        aria-controls="ticket-list"
        :disabled="!projects.currentId"
        @click="toggleArchive"
      >
        <Icon :name="tickets.archived ? 'back' : 'archive'" />
      </IconButton>
    </header>
    <TabsRoot
      class="flex min-h-0 flex-1 flex-col"
      :model-value="tab"
      activation-mode="manual"
      @update:model-value="chooseFolder"
    >
      <div class="px-4 pt-3 pb-1">
        <div class="search-field">
          <Icon name="search" />
          <input
            type="search"
            :value="tickets.query"
            placeholder="Найти клиента…"
            aria-label="Поиск клиента"
            maxlength="100"
            :disabled="!projects.currentId"
            @input="search"
          />
        </div>
        <FolderTabs />
      </div>
      <!-- The panel starts with the focusable list, so it is not a Tab stop of its own. -->
      <TabsContent :value="tab" as-child>
        <div class="flex min-h-0 flex-1 flex-col outline-none" tabindex="-1">
          <TicketList />
          <button v-if="tickets.hasMore" class="quiet mx-auto mb-2" type="button" @click="more">Показать ещё</button>
        </div>
      </TabsContent>
    </TabsRoot>
    <AccountFooter />
  </aside>
</template>
