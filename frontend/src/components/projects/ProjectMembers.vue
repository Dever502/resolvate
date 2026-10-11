<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { MemberCandidate, Project, ProjectMember } from "../../api/types";
import { errorMessage, useRequest } from "../../composables/useRequest";
import { avatarTone } from "../../lib/format";
import { initials } from "../../lib/initials";
import { useProjectsStore } from "../../stores/projects";
import { useSessionStore } from "../../stores/session";
import { useStaffStore } from "../../stores/staff";
import StaffPicker, { type StaffOption } from "../staff/StaffPicker.vue";
import ConfirmDialog from "../ui/ConfirmDialog.vue";

// Who works in the project: its administrator and the operators with access. Access is granted by
// searching the server's candidates (active accounts without access, at most 50) and revoked after
// a confirmation. The installation administrator can also hand the project to another administrator.
const props = defineProps<{ project: Project }>();
const session = useSessionStore();
const projects = useProjectsStore();
const staff = useStaffStore();
const owner = computed(() => session.account?.role === "admin");
const members = ref<ProjectMember[]>([]);
const loaded = ref(false);
const loadError = ref("");
const request = useRequest();
const confirm = useRequest();
const candidate = ref<StaffOption | null>(null);
const candidateKey = ref(0);
const candidateError = ref("");
const removing = ref<ProjectMember | null>(null);
const successor = ref<StaffOption | null>(null);
const successorKey = ref(0);
const successorError = ref("");
const transferring = ref(false);
let controller: AbortController | null = null;

const admin = computed(() => members.value.find((member) => member.role === "admin") ?? null);
const operators = computed(() => members.value.filter((member) => member.role !== "admin"));
const removingOpen = computed({
  get: () => removing.value !== null,
  set: (value) => { if (!value && !confirm.busy) removing.value = null; },
});
const transferOpen = computed({
  get: () => transferring.value,
  set: (value) => { if (!value && !confirm.busy) transferring.value = false; },
});

async function load(): Promise<void> {
  controller?.abort();
  const own = new AbortController();
  controller = own;
  loadError.value = "";
  try {
    const rows = await session.api<ProjectMember[]>(`projects/${props.project.id}/members`, { signal: own.signal });
    if (own.signal.aborted) return;
    members.value = rows;
    loaded.value = true;
  } catch (error) {
    if (!own.signal.aborted) loadError.value = errorMessage(error);
  } finally {
    if (controller === own) controller = null;
  }
}
onMounted(load);
onBeforeUnmount(() => controller?.abort());

async function candidates(query: string, signal: AbortSignal): Promise<StaffOption[]> {
  const rows = await session.api<MemberCandidate[]>(
    `projects/${props.project.id}/member-candidates?q=${encodeURIComponent(query)}`, { signal });
  return rows.map((row) => ({ value: row.login, label: row.name, detail: row.login }));
}

// Any active account can take over the project, a current operator included.
async function successors(query: string): Promise<StaffOption[]> {
  if (!staff.loaded) await staff.refresh();
  const needle = query.toLowerCase();
  return staff.accounts
    .filter((account) => account.active && account.id !== props.project.admin_id)
    .filter((account) => !needle || account.login.includes(needle) || account.name.toLowerCase().includes(needle))
    .slice(0, 50)
    .map((account) => ({ value: account.login, label: account.name, detail: account.login }));
}

function describe(member: ProjectMember): string {
  const parts = [member.login, member.role === "admin" ? "администратор проекта" : "оператор"];
  if (!member.active) parts.push("аккаунт отключён");
  parts.push(member.telegram_id ? `Telegram ID ${member.telegram_id}` : "Telegram ID не привязан");
  return parts.join(" · ");
}

async function grant(): Promise<void> {
  if (request.busy) return;
  const chosen = candidate.value;
  candidateError.value = chosen ? "" : "Выберите сотрудника из списка.";
  if (!chosen) return;
  const done = await request.run(async () => {
    await projects.grant(props.project.id, chosen.value);
    await load();
    return `Доступ выдан: ${chosen.label}.`;
  });
  if (!done) return;
  candidate.value = null;
  candidateKey.value++;
}

function askRemove(member: ProjectMember): void {
  if (request.busy) return;
  confirm.clear();
  removing.value = member;
}

async function remove(): Promise<void> {
  const member = removing.value;
  if (!member) return;
  const done = await confirm.run(async () => {
    await projects.revoke(props.project.id, member.login);
    await load();
  });
  if (!done) return;
  removing.value = null;
  request.clear();
  request.status = member.id === session.account?.id
    ? "Ваш доступ к переписке проекта отозван."
    : `Доступ отозван: ${member.name}. Переписка проекта сохранена.`;
}

function askTransfer(): void {
  if (request.busy) return;
  successorError.value = successor.value ? "" : "Выберите нового администратора из списка.";
  if (!successor.value) return;
  confirm.clear();
  transferring.value = true;
}

async function transfer(): Promise<void> {
  const chosen = successor.value;
  if (!chosen) return;
  const done = await confirm.run(async () => {
    await projects.transfer(props.project.id, chosen.value);
    await load();
  });
  if (!done) return;
  transferring.value = false;
  successor.value = null;
  successorKey.value++;
  request.clear();
  request.status = `Новый администратор проекта: ${chosen.label}.`;
}

const transferWarning = computed(() => {
  const current = admin.value;
  if (current?.id === session.account?.id) {
    return "Вы потеряете доступ к проекту и его подключениям. Доступ оператора можно выдать себе снова после передачи.";
  }
  const name = current?.name ?? "Текущий администратор";
  return `${name} теряет доступ к проекту и его подключениям. Доступ оператора можно выдать снова после передачи.`;
});
const ordered = computed(() => [...(admin.value ? [admin.value] : []), ...operators.value]);
</script>

<template>
  <div>
    <p v-if="request.status" class="error" :class="{ success: !request.failed }" :role="request.failed ? 'alert' : 'status'">{{ request.status }}</p>
    <p v-if="loadError" class="error" role="alert">
      {{ loadError }}
      <button type="button" class="quiet ml-1" @click="load">Повторить</button>
    </p>
    <p v-else-if="!loaded" class="muted">Загружаем участников…</p>
    <template v-else>
      <ul class="admin-list" aria-label="Участники проекта">
        <li v-for="member in ordered" :key="member.id" class="admin-row">
          <span class="avatar" :class="avatarTone(member.id)" aria-hidden="true">{{ initials(member.name) }}</span>
          <div class="min-w-0 flex-1">
            <p class="admin-row-title">
              <span class="[overflow-wrap:anywhere]">{{ member.name }}</span>
              <span v-if="member.id === session.account?.id" class="pill">Вы</span>
            </p>
            <p class="muted small m-0 [overflow-wrap:anywhere]">{{ describe(member) }}</p>
          </div>
          <button v-if="member.role !== 'admin'" type="button" class="quiet" :aria-disabled="request.busy || undefined"
            :aria-label="`Отозвать доступ: ${member.name}`" @click="askRemove(member)">Отозвать доступ</button>
        </li>
      </ul>
      <p v-if="!operators.length" class="muted small">Операторов пока нет: выдайте доступ сотрудникам ниже.</p>
    </template>

    <form class="mt-5 border-t border-border pt-4" novalidate @submit.prevent="grant">
      <h3 class="mb-1">Выдать доступ</h3>
      <p class="muted small mt-0">В поиске только активные сотрудники без доступа к проекту: участники перечислены выше, отключённые аккаунты не показываются.</p>
      <StaffPicker
        :key="candidateKey"
        v-model="candidate"
        label="Сотрудник"
        :search="candidates"
        chosen-hint="Нажмите «Выдать доступ», чтобы добавить сотрудника."
        @update:model-value="candidateError = ''"
      />
      <p v-if="candidateError" class="field-error">{{ candidateError }}</p>
      <div class="mt-3 flex justify-end">
        <button type="submit" class="primary" :aria-disabled="request.busy || undefined">{{ request.busy ? "Выдаём…" : "Выдать доступ" }}</button>
      </div>
    </form>

    <details v-if="owner" class="disclosure">
      <summary>Сменить администратора проекта</summary>
      <p class="muted small">
        Сейчас: {{ admin ? (admin.id === session.account?.id ? `вы (${admin.login})` : `${admin.name} · ${admin.login}`) : "—" }}.
        Администратор проекта настраивает подключения и управляет участниками.
      </p>
      <form novalidate @submit.prevent="askTransfer">
        <StaffPicker
          :key="successorKey"
          v-model="successor"
          label="Новый администратор"
          :search="successors"
          chosen-hint="Нажмите «Передать проект» и подтвердите передачу."
          @update:model-value="successorError = ''"
        />
        <p v-if="successorError" class="field-error">{{ successorError }}</p>
        <div class="mt-3 flex justify-end">
          <button type="submit" class="secondary" :aria-disabled="request.busy || undefined">Передать проект</button>
        </div>
      </form>
    </details>

    <ConfirmDialog
      v-model:open="removingOpen"
      :title="`Отозвать доступ: ${removing?.name ?? ''}?`"
      description="Сотрудник перестанет видеть переписку проекта и отвечать в ней. Переписка сохранится, доступ можно выдать снова."
      confirm-label="Отозвать доступ"
      busy-label="Отзываем…"
      :busy="confirm.busy"
      :error="confirm.failed ? confirm.status : ''"
      danger
      @confirm="remove"
    />
    <ConfirmDialog
      v-model:open="transferOpen"
      title="Передать управление проектом?"
      :description="`Новый администратор проекта «${project.name}»: ${successor ? `${successor.label} · ${successor.detail}` : ''}. ${transferWarning}`"
      confirm-label="Передать проект"
      busy-label="Передаём…"
      :busy="confirm.busy"
      :error="confirm.failed ? confirm.status : ''"
      danger
      @confirm="transfer"
    />
  </div>
</template>
