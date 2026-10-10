<script setup lang="ts">
import { ref, watch } from "vue";
import type { QuickReply, QuickReplyGroup } from "../../api/types";
import { useSessionStore } from "../../stores/session";
import ModalDialog from "../ui/ModalDialog.vue";

const props = defineProps<{ projectId: string }>();
const open = defineModel<boolean>("open", { required: true });
const session = useSessionStore();
const groups = ref<QuickReplyGroup[]>([]);
const replies = ref<QuickReply[]>([]);
const selected = ref<QuickReplyGroup | null>(null);
const editing = ref<QuickReply | null>(null);
const moving = ref<QuickReply | null>(null);
const groupName = ref("");
const content = ref("");
const query = ref("");
const busy = ref(false);
const status = ref("");
const moreGroups = ref(false);
const moreReplies = ref(false);
let generation = 0;

async function loadGroups(more = false): Promise<void> {
  const rows = await session.api<QuickReplyGroup[]>(
    `reply-groups?q=${encodeURIComponent(query.value)}&offset=${more ? groups.value.length : 0}`, {}, props.projectId);
  groups.value = more ? [...groups.value, ...rows] : rows;
  moreGroups.value = rows.length === 50;
}

async function loadReplies(more = false): Promise<void> {
  if (!selected.value) return;
  const rows = await session.api<QuickReply[]>(
    `replies?group_id=${selected.value.id}&q=${encodeURIComponent(query.value)}&offset=${more ? replies.value.length : 0}`, {}, props.projectId);
  replies.value = more ? [...replies.value, ...rows] : rows;
  moreReplies.value = rows.length === 50;
}

async function run(action: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  status.value = "";
  const sent = generation;
  try { await action(); }
  catch (error) {
    if (sent === generation) status.value = error instanceof Error ? error.message : "Не удалось сохранить.";
  } finally { if (sent === generation) busy.value = false; }
}

watch(open, (value) => {
  generation++;
  if (!value) return;
  groups.value = []; replies.value = []; selected.value = null; editing.value = null; moving.value = null;
  content.value = ""; groupName.value = ""; query.value = ""; status.value = ""; busy.value = false;
  void run(() => loadGroups());
});

async function select(group: QuickReplyGroup | null): Promise<void> {
  if (busy.value) return;
  if (group && moving.value) {
    const reply = moving.value;
    await run(async () => {
      await post(`replies/${reply.id}/edit`, { group_id: group.id, text: reply.text, revision: reply.revision });
      moving.value = null; selected.value = group; groupName.value = group.name; query.value = "";
      await loadReplies();
    });
    return;
  }
  selected.value = group;
  editing.value = null;
  content.value = "";
  groupName.value = group?.name ?? "";
  query.value = "";
  replies.value = [];
  await run(() => group ? loadReplies() : loadGroups());
}

async function move(reply: QuickReply): Promise<void> {
  moving.value = reply; selected.value = null; query.value = ""; groupName.value = "";
  editing.value = null; content.value = "";
  await run(() => loadGroups());
}

function post(path: string, data: unknown): Promise<unknown> {
  return session.api(path, { method: "POST", data }, props.projectId);
}

async function saveGroup(): Promise<void> {
  await run(async () => {
    const group = selected.value;
    if (group) {
      await post(`reply-groups/${group.id}/rename`, { name: groupName.value, revision: group.revision });
      // Refresh the exact group, even if it moved to another search/page after renaming.
      const name = groupName.value.trim().replace(/^\//, "").normalize("NFKC").toLowerCase();
      const fresh = await session.api<QuickReplyGroup[]>(`reply-groups?q=${encodeURIComponent(name)}`, {}, props.projectId);
      selected.value = fresh.find(row => row.id === group.id) ?? null;
      editing.value = null; content.value = "";
      await loadReplies();
    } else {
      await post("reply-groups", { name: groupName.value });
      groupName.value = ""; query.value = "";
      await loadGroups();
    }
  });
}

async function deleteGroup(): Promise<void> {
  const group = selected.value;
  if (!group) return;
  await run(async () => {
    await post(`reply-groups/${group.id}/delete`, { revision: group.revision });
    selected.value = null; groupName.value = ""; query.value = "";
    await loadGroups();
  });
}

async function saveReply(): Promise<void> {
  const group = selected.value;
  if (!group) return;
  await run(async () => {
    const reply = editing.value;
    await post(reply ? `replies/${reply.id}/edit` : "replies",
      { group_id: group.id, text: content.value, ...(reply ? { revision: reply.revision } : {}) });
    editing.value = null; content.value = "";
    await loadReplies();
  });
}

async function deleteReply(reply: QuickReply): Promise<void> {
  await run(async () => {
    await post(`replies/${reply.id}/delete`, { revision: reply.revision });
    if (editing.value?.id === reply.id) { editing.value = null; content.value = ""; }
    await loadReplies();
  });
}
</script>

<template>
  <ModalDialog v-model:open="open" title="Готовые ответы" :locked="busy" wide
    description="Общий каталог проекта. Изменения автоматически появятся в Telegram.">
    <p v-if="status" class="form-status error" role="alert">{{ status }} Черновик сохранён в форме. Обновите список перед повторной правкой.</p>
    <div class="flex items-center gap-2">
      <p v-if="moving" class="muted">Выберите группу для переноса ответа.</p>
      <button v-if="moving" type="button" class="quiet" :disabled="busy" @click="moving = null">Отмена переноса</button>
      <button v-if="selected" type="button" class="quiet" :disabled="busy" @click="select(null)">← Группы</button>
      <h3 v-if="selected" class="m-0 min-w-0 flex-1 truncate">/{{ selected.name }}</h3>
    </div>
    <form class="flex items-center gap-2" @submit.prevent="run(() => selected ? loadReplies() : loadGroups())">
      <input v-model="query" class="min-w-0 flex-1" maxlength="100" aria-label="Поиск в каталоге" placeholder="Поиск…" :disabled="busy" />
      <button type="submit" class="quiet" :disabled="busy">Найти</button>
    </form>
    <div v-if="!selected">
      <button v-for="group in groups" :key="group.id" type="button" class="reply-option text-left"
        :disabled="busy" @click="select(group)">/{{ group.name }}</button>
      <p v-if="!groups.length && !busy" class="muted">Групп пока нет или ничего не найдено.</p>
      <button v-if="moreGroups" type="button" class="quiet" :disabled="busy" @click="run(() => loadGroups(true))">Ещё группы</button>
    </div>
    <div v-else class="grid gap-3">
      <div v-for="reply in replies" :key="reply.id" class="border-b border-border pb-3">
        <p class="whitespace-pre-wrap [overflow-wrap:anywhere]">{{ reply.text }}</p>
        <div class="flex gap-2">
          <button type="button" class="quiet" :disabled="busy"
            @click="editing = reply; content = reply.text">Изменить ответ</button>
          <button type="button" class="quiet" :disabled="busy" @click="deleteReply(reply)">Удалить ответ</button>
          <button type="button" class="quiet" :disabled="busy" @click="move(reply)">Перенести</button>
        </div>
      </div>
      <p v-if="!replies.length && !busy" class="muted">Ответов пока нет или ничего не найдено.</p>
      <button v-if="moreReplies" type="button" class="quiet" :disabled="busy" @click="run(() => loadReplies(true))">Ещё ответы</button>
      <form class="grid gap-3" @submit.prevent="saveReply">
        <label>{{ editing ? 'Редактирование ответа' : 'Новый ответ' }}
          <textarea v-model="content" rows="5" maxlength="3900" required :disabled="busy" aria-label="Текст готового ответа" />
        </label>
        <div class="flex justify-end gap-2">
          <button v-if="editing" type="button" class="quiet" :disabled="busy" @click="editing = null; content = ''">Отмена</button>
          <button type="submit" class="primary" :disabled="busy">{{ editing ? 'Сохранить ответ' : 'Добавить ответ' }}</button>
        </div>
      </form>
    </div>
    <form v-if="!moving" class="grid gap-3 border-t border-border pt-4" @submit.prevent="saveGroup">
      <label>{{ selected ? 'Название группы' : 'Новая группа' }}
        <input v-model="groupName" maxlength="49" required :disabled="busy" placeholder="/оплата" aria-label="Название группы" />
      </label>
      <div class="flex justify-end gap-2">
        <button v-if="selected" type="button" class="quiet" :disabled="busy" @click="deleteGroup">Удалить пустую группу</button>
        <button type="submit" class="primary" :disabled="busy">{{ selected ? 'Переименовать' : 'Создать группу' }}</button>
      </div>
    </form>
  </ModalDialog>
</template>
