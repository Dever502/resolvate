<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, useTemplateRef, watch } from "vue";
import { ApiError, type ApiOptions } from "../../api/client";
import type { QuickReply, QuickReplyGroup } from "../../api/types";
import { useNotice } from "../../composables/useNotice";
import { errorMessage, useRequest } from "../../composables/useRequest";
import { PAGE, findGroup, findReply, readPages } from "../../lib/quickReplies";
import { useSessionStore } from "../../stores/session";
import ConfirmDialog from "../ui/ConfirmDialog.vue";
import Icon from "../ui/Icon.vue";
import ModalDialog from "../ui/ModalDialog.vue";
import ReplyEditor from "./ReplyEditor.vue";
import ReplyGroupList from "./ReplyGroupList.vue";
import ReplyList from "./ReplyList.vue";
import ReplyMove from "./ReplyMove.vue";
import ReplySearchResults from "./ReplySearchResults.vue";

// The project's shared quick replies (src/resolvate/quick_reply_catalog.py) as master–detail: the
// groups on the left; on the right one thing at a time — the open group's replies, a reply being
// written or moved, or the results of a search across the catalog. Revisions keep another
// operator's change from being overwritten unseen: a conflict keeps the draft and shows the
// server's version. The backend delivers every change to Telegram itself.
const CONFLICT = "Запись изменена другим оператором. Обновите каталог.";
const GROUP_GONE = "Группа не найдена.";
const props = defineProps<{ projectId: string }>();
const open = defineModel<boolean>("open", { required: true });
const session = useSessionStore();
const request = useRequest();
const api = <T,>(path: string, options: ApiOptions = {}) => session.api<T>(path, options, props.projectId);
const encode = encodeURIComponent;

const groupList = useTemplateRef<{ focus: () => void }>("group-list");
const replyList = useTemplateRef<{ focusAdd: () => void; focusGroupMenu: () => void; focusReply: (id: string) => void }>("reply-list");
const results = useTemplateRef<{ focusReply: (id: string) => boolean }>("results");
const searchField = useTemplateRef<HTMLInputElement>("search");

// The groups column (all groups by name, 50 a page) and every group name seen: search results
// carry only their group's id.
const groups = ref<QuickReplyGroup[]>([]);
const groupsMore = ref(false);
const groupsLoading = ref(false);
const groupsError = ref("");
const names = reactive(new Map<string, string>());
let groupsRequest = 0;
let namesFrom = 0;

// The open group and its replies (filtered while the search is limited to it).
const selected = ref<QuickReplyGroup | null>(null);
const replies = ref<QuickReply[]>([]);
const repliesMore = ref(false);
const repliesLoading = ref(false);
const repliesError = ref("");
let repliesRequest = 0;
let repliesController: AbortController | null = null;
let shownQuery = "";

// The search: across the catalog (groups by name, replies by text) or inside the open group.
const query = ref("");
const scope = ref<"catalog" | "group">("catalog");
const term = computed(() => query.value.trim());
const inGroup = computed(() => scope.value === "group" && selected.value !== null);
const groupQuery = computed(() => (inGroup.value ? term.value : ""));
const searching = computed(() => !inGroup.value && term.value !== "");
const found = reactive({ groups: [] as QuickReplyGroup[], replies: [] as QuickReply[], moreGroups: false, moreReplies: false, loading: false, error: "" });
let searchRequest = 0;
let searchController: AbortController | null = null;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let groupTimer: ReturnType<typeof setTimeout> | undefined;

// Besides a list the right side shows a reply being written or moved.
type Panel =
  | { kind: "list" }
  | { kind: "editor"; reply: QuickReply | null; group: QuickReplyGroup; missing: boolean }
  | { kind: "move"; reply: QuickReply; group: QuickReplyGroup };
const panel = ref<Panel>({ kind: "list" });
const editing = computed(() => panel.value.kind !== "list");
/** Narrow screens show one level at a time: the groups, or the right side. */
const pane = ref<"groups" | "detail">("groups");
let paneBefore: "groups" | "detail" = "groups";
const creatingGroup = ref(false);
const renamingGroup = ref(false);
const editorDirty = ref(false);
const conflict = ref<string | null>(null);
const panelError = ref("");
const groupError = ref("");
// A success is a short toast that disappears by itself; a warning stays until the next step.
const { notice, success, warning, clear: clearNotice } = useNotice();
const removingReply = ref<QuickReply | null>(null);
const removingGroup = ref<QuickReplyGroup | null>(null);
const discarding = ref<(() => void) | null>(null);
const confirmError = ref("");

const removingReplyOpen = computed({
  get: () => removingReply.value !== null,
  set: (value) => { if (!value && !request.busy) removingReply.value = null; },
});
const removingGroupOpen = computed({
  get: () => removingGroup.value !== null,
  set: (value) => { if (!value && !request.busy) removingGroup.value = null; },
});
const discardOpen = computed({
  get: () => discarding.value !== null,
  set: (value) => { if (!value) discarding.value = null; },
});

// One change at a time (a repeated click is ignored); a refusal comes back with its HTTP status.
type Outcome<T> = { ok: true; value: T } | { ok: false; status: number; message: string };
async function send<T>(path: string, data: unknown): Promise<Outcome<T>> {
  let outcome: Outcome<T> = { ok: false, status: 0, message: "" };
  await request.run(async () => {
    try {
      outcome = { ok: true, value: await api<T>(path, { method: "POST", data }) };
    } catch (error) {
      outcome = { ok: false, status: error instanceof ApiError ? error.status : 0, message: errorMessage(error) };
      throw error;
    }
  });
  request.clear();
  return outcome;
}

const readGroups = (offset: number) => api<QuickReplyGroup[]>(`reply-groups?q=&offset=${offset}`);
// A group deleted meanwhile reads as empty: its replies are gone too.
const readGroupReplies = (groupId: string, offset: number) =>
  api<QuickReply[]>(`replies?group_id=${encode(groupId)}&q=&offset=${offset}`).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return [];
    throw error;
  });

function remember(rows: QuickReplyGroup[]): void {
  for (const group of rows) names.set(group.id, group.name);
}

async function loadGroups(append = false): Promise<void> {
  const sent = ++groupsRequest;
  groupsLoading.value = true;
  groupsError.value = "";
  try {
    // A refresh reloads as many pages as were shown: the column does not jump back to the top.
    const pages = append ? 1 : Math.max(1, Math.ceil(groups.value.length / PAGE));
    const { rows, more } = await readPages(readGroups, pages, append ? groups.value : []);
    if (sent !== groupsRequest) return;
    remember(rows);
    groups.value = rows;
    groupsMore.value = more;
    namesFrom = Math.max(namesFrom, rows.length);
    // The open group stays open, with its fresh name and revision.
    const fresh = rows.find((group) => group.id === selected.value?.id);
    if (fresh) selected.value = fresh;
    else if (!selected.value && rows[0] && !editing.value) choose(rows[0], { show: false, keepSearch: true });
  } catch (error) {
    if (sent === groupsRequest) groupsError.value = errorMessage(error);
  } finally {
    if (sent === groupsRequest) groupsLoading.value = false;
  }
}

async function loadReplies(append = false): Promise<void> {
  const group = selected.value;
  if (!group) return;
  clearTimeout(groupTimer);
  repliesController?.abort();
  const own = new AbortController();
  repliesController = own;
  const sent = ++repliesRequest;
  const q = groupQuery.value;
  shownQuery = q;
  repliesLoading.value = true;
  repliesError.value = "";
  try {
    const pages = append ? 1 : Math.max(1, Math.ceil(replies.value.length / PAGE));
    const { rows, more } = await readPages(
      (offset) => api<QuickReply[]>(`replies?group_id=${encode(group.id)}&q=${encode(q)}&offset=${offset}`, { signal: own.signal }),
      pages, append ? replies.value : []);
    if (sent !== repliesRequest) return;
    replies.value = rows;
    repliesMore.value = more;
  } catch (error) {
    if (sent !== repliesRequest) return;
    if (error instanceof ApiError && error.status === 404) groupGone(group);
    else repliesError.value = errorMessage(error);
  } finally {
    if (sent === repliesRequest) repliesLoading.value = false;
  }
}

// Search results carry group ids only: the names come from group pages not read yet.
async function resolveNames(rows: QuickReply[], signal: AbortSignal): Promise<void> {
  for (let page = 0; page < 20 && rows.some((reply) => !names.has(reply.group_id)); page++) {
    const more = await api<QuickReplyGroup[]>(`reply-groups?q=&offset=${namesFrom}`, { signal });
    remember(more);
    namesFrom += more.length;
    if (more.length < PAGE) {
      // The end of the catalog: groups created or renamed since then are read on the next pass.
      namesFrom = 0;
      break;
    }
  }
}

async function runSearch(more: "" | "groups" | "replies" = ""): Promise<void> {
  if (!searching.value) return;
  clearTimeout(searchTimer);
  searchController?.abort();
  const own = new AbortController();
  searchController = own;
  const sent = ++searchRequest;
  const q = encode(term.value);
  found.loading = true;
  found.error = "";
  try {
    const [groupRows, replyRows] = await Promise.all([
      more === "replies" ? null
        : api<QuickReplyGroup[]>(`reply-groups?q=${q}&offset=${more === "groups" ? found.groups.length : 0}`, { signal: own.signal }),
      more === "groups" ? null
        : api<QuickReply[]>(`replies?q=${q}&offset=${more === "replies" ? found.replies.length : 0}`, { signal: own.signal }),
    ]);
    if (sent !== searchRequest) return;
    if (replyRows) await resolveNames(replyRows, own.signal);
    if (sent !== searchRequest) return;
    if (groupRows) {
      remember(groupRows);
      found.groups = more === "groups" ? [...found.groups, ...groupRows] : groupRows;
      found.moreGroups = groupRows.length === PAGE;
    }
    if (replyRows) {
      found.replies = more === "replies" ? [...found.replies, ...replyRows] : replyRows;
      found.moreReplies = replyRows.length === PAGE;
    }
  } catch (error) {
    if (sent === searchRequest) found.error = errorMessage(error);
  } finally {
    if (sent === searchRequest) found.loading = false;
  }
}

// Typing restarts a short wait; an answer to an older query is dropped.
watch(() => (searching.value ? term.value : null), (value, old) => {
  clearTimeout(searchTimer);
  if (value === null) {
    searchController?.abort();
    searchRequest++;
    found.loading = false;
    // Clearing the search returns to where it started.
    if (old !== null) pane.value = selected.value ? paneBefore : "groups";
    return;
  }
  if (old === null) {
    paneBefore = pane.value;
    Object.assign(found, { groups: [], replies: [], moreGroups: false, moreReplies: false, error: "" });
  }
  clearNotice("warning");
  pane.value = "detail";
  found.loading = true;
  searchTimer = setTimeout(() => void runSearch(), 250);
});

watch(groupQuery, (value) => {
  clearTimeout(groupTimer);
  if (value) pane.value = "detail";
  if (value !== shownQuery) groupTimer = setTimeout(() => void loadReplies(), 250);
});

// While a draft is unsaved, leaving it asks first: another group, closing the window or the page.
let discardFrom: Element | null = null;
function guard(action: () => void): void {
  if (!editing.value || !editorDirty.value) return action();
  discardFrom = document.activeElement;
  discarding.value = action;
}

// "Вернуться к ответу" returns focus where the question came from, or to the draft when that is gone
// (the name field of a group closes once the group is created).
function discardClosed(event: Event): void {
  if (discardFrom instanceof HTMLElement && discardFrom.isConnected) return;
  event.preventDefault();
  document.querySelector<HTMLElement>(".dialog-catalog .catalog-textarea")?.focus();
}

function discard(): void {
  const action = discarding.value;
  discarding.value = null;
  editorDirty.value = false;
  action?.();
}

function keep(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = "";
}
watch(editorDirty, (value) => {
  if (value) window.addEventListener("beforeunload", keep);
  else window.removeEventListener("beforeunload", keep);
});

function closePanel(): void {
  panel.value = { kind: "list" };
  editorDirty.value = false;
  conflict.value = null;
  panelError.value = "";
}

/** Opens a group; `show` brings it forward on a narrow screen, `keepSearch` leaves a search running. */
function choose(group: QuickReplyGroup, { show = true, keepSearch = false } = {}): void {
  closePanel();
  renamingGroup.value = false;
  selected.value = group;
  replies.value = [];
  if (show) {
    pane.value = "detail";
    paneBefore = "detail";
  }
  if (!keepSearch) query.value = "";
  void loadReplies();
}

function select(group: QuickReplyGroup): void {
  clearNotice("warning");
  if (group.id === selected.value?.id && !searching.value) guard(() => { closePanel(); pane.value = "detail"; });
  else guard(() => choose(group));
}

async function openGroup(id: string): Promise<void> {
  // A group of a search result may lie beyond the loaded pages: it is found by its name.
  let group = groups.value.find((item) => item.id === id) ?? found.groups.find((item) => item.id === id);
  if (!group && names.has(id)) {
    const rows = await api<QuickReplyGroup[]>(`reply-groups?q=${encode(names.get(id) ?? "")}`).catch(() => []);
    group = rows.find((item) => item.id === id);
  }
  if (!group) {
    warning("Группа не найдена: возможно, её удалил другой оператор.");
    return;
  }
  const target = group;
  guard(() => {
    scope.value = "catalog";
    choose(target);
    void focusList();
  });
}

function groupGone(group: QuickReplyGroup): void {
  if (selected.value?.id === group.id) {
    warning(`Группы /${group.name} больше нет: её удалил другой оператор.`);
    selected.value = null;
    replies.value = [];
    renamingGroup.value = false;
    if (!editing.value) pane.value = "groups";
    else {
      // The listbox takes focus when its value changes in code; the open editor keeps it.
      const active = document.activeElement;
      void settled().then(() => {
        if (active instanceof HTMLElement && active !== document.body && active.isConnected) active.focus();
        else document.querySelector<HTMLElement>(".dialog-catalog .catalog-textarea")?.focus();
      });
    }
  }
  void loadGroups();
}

// Reka's listbox moves focus to a group selected in code (a new group, one opened from the search)
// a few microtasks after the render: focus is placed once that has happened.
const settled = () => new Promise<void>((resolve) => setTimeout(resolve));

// Once the right side shows a list again, focus returns to where the user was.
async function focusList(target: { reply?: string; menu?: boolean } = {}): Promise<void> {
  await settled();
  if (searching.value) {
    if (!target.reply || !results.value?.focusReply(target.reply)) searchField.value?.focus();
  } else if (target.reply) replyList.value?.focusReply(target.reply);
  else if (target.menu) replyList.value?.focusGroupMenu();
  else replyList.value?.focusAdd();
}

// On a narrow screen the pane that had focus may just have been hidden: focus moves to the one shown.
watch(pane, async (value) => {
  await settled();
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && active.getClientRects().length) return;
  if (value === "groups") groupList.value?.focus();
  else await focusList();
});

/** The shown list after a change; a list that fails to reload says so itself, the change is saved. */
async function refresh(): Promise<void> {
  if (searching.value) await runSearch();
  else await loadReplies();
}

/** Focus goes to the reply that took the place of one that left the list. */
async function focusNear(index: number): Promise<void> {
  const rows = searching.value ? found.replies : replies.value;
  const next = rows[Math.min(index, rows.length - 1)];
  await focusList(next ? { reply: next.id } : {});
}

/** The group's current name and revision after a conflict, wherever it sorts now; null when it is gone. */
async function freshGroup(id: string): Promise<QuickReplyGroup | null> {
  const fresh = await findGroup(readGroups, id);
  if (fresh) {
    remember([fresh]);
    if (selected.value?.id === id) selected.value = fresh;
  }
  void loadGroups();
  return fresh;
}

function groupOf(reply: QuickReply): QuickReplyGroup {
  return [selected.value, ...groups.value, ...found.groups].find((group) => group?.id === reply.group_id)
    ?? { id: reply.group_id, name: names.get(reply.group_id) ?? "…", revision: 0 };
}

function add(): void {
  if (!selected.value || request.busy) return;
  clearNotice("warning");
  panel.value = { kind: "editor", reply: null, group: selected.value, missing: false };
  pane.value = "detail";
}

function act(reply: QuickReply, key: "edit" | "move" | "remove"): void {
  if (request.busy) return;
  clearNotice("warning");
  if (key === "remove") {
    confirmError.value = "";
    removingReply.value = reply;
    return;
  }
  panel.value = key === "edit"
    ? { kind: "editor", reply, group: groupOf(reply), missing: false }
    : { kind: "move", reply, group: groupOf(reply) };
  pane.value = "detail";
}

function cancelPanel(): void {
  const current = panel.value;
  if (current.kind === "list" || request.busy) return;
  guard(() => {
    closePanel();
    // The group was deleted meanwhile: back to the groups.
    if (!selected.value && !searching.value) {
      pane.value = "groups";
      void settled().then(() => groupList.value?.focus());
    } else void focusList(current.reply && !(current.kind === "editor" && current.missing) ? { reply: current.reply.id } : {});
  });
}

async function saveReply(text: string): Promise<void> {
  const current = panel.value;
  if (current.kind !== "editor" || request.busy) return;
  const reply = current.missing ? null : current.reply;
  panelError.value = "";
  const result = reply
    ? await send<QuickReply>(`replies/${reply.id}/edit`, { group_id: current.group.id, text, revision: reply.revision })
    : await send<QuickReply>("replies", { group_id: current.group.id, text });
  if (panel.value !== current) return;
  if (!result.ok) {
    if (result.status === 404 && result.message === GROUP_GONE) {
      panelError.value = `Группы /${current.group.name} больше нет: её удалил другой оператор. Скопируйте текст, прежде чем закрыть редактор.`;
      groupGone(current.group);
    } else if (reply && result.status === 404) missing(current);
    else if (reply && result.status === 409) await showConflict(current, reply);
    else panelError.value = result.message;
    return;
  }
  success(reply ? "Ответ сохранён." : `Ответ добавлен в /${current.group.name}.`);
  closePanel();
  await refresh();
  await focusList({ reply: result.value.id });
}

function missing(current: Extract<Panel, { kind: "editor" }>): void {
  panel.value = { ...current, missing: true };
  conflict.value = null;
  panelError.value = `Этого ответа больше нет: его удалил или перенёс другой оператор. «Добавить ответ» сохранит ваш текст новым ответом в /${current.group.name}.`;
}

async function showConflict(current: Extract<Panel, { kind: "editor" }>, reply: QuickReply): Promise<void> {
  let fresh: QuickReply | null;
  try {
    fresh = await findReply(readGroupReplies, reply);
  } catch (error) {
    panelError.value = `Ответ изменил другой оператор, а его версию загрузить не удалось: ${errorMessage(error)} Ваш текст остался в поле, повторите сохранение позже.`;
    return;
  }
  if (panel.value !== current) return;
  if (!fresh) {
    missing(current);
    return;
  }
  // The next "Сохранить" overwrites knowingly: it carries the revision just shown.
  panel.value = { ...current, reply: fresh };
  conflict.value = fresh.text;
  void refresh();
}

async function moveReply(target: QuickReplyGroup): Promise<void> {
  const current = panel.value;
  if (current.kind !== "move" || request.busy) return;
  panelError.value = "";
  const index = (searching.value ? found.replies : replies.value).findIndex((item) => item.id === current.reply.id);
  const result = await send(`replies/${current.reply.id}/edit`, { group_id: target.id, text: current.reply.text, revision: current.reply.revision });
  if (panel.value !== current) return;
  if (!result.ok) {
    if (result.status === 404 && result.message === GROUP_GONE) {
      panelError.value = `Группы /${target.name} больше нет: её удалил другой оператор. Выберите другую группу.`;
    } else if (result.status === 404) {
      closePanel();
      warning("Этого ответа больше нет: его удалил или перенёс другой оператор.");
      await refresh();
      await focusList();
    } else if (result.status === 409) {
      let fresh: QuickReply | null = null;
      try {
        fresh = await findReply(readGroupReplies, current.reply);
      } catch (error) {
        panelError.value = `Ответ изменил другой оператор, а его версию загрузить не удалось: ${errorMessage(error)}`;
        return;
      }
      if (panel.value !== current) return;
      if (fresh) {
        panel.value = { ...current, reply: fresh };
        panelError.value = "Ответ изменил другой оператор: проверьте его текущий текст выше и подтвердите перенос снова.";
      } else {
        closePanel();
        warning("Этого ответа больше нет: его удалил или перенёс другой оператор.");
        await refresh();
        await focusList();
      }
    } else panelError.value = result.message;
    return;
  }
  remember([target]);
  success(`Ответ перенесён в /${target.name}.`);
  closePanel();
  await refresh();
  await focusNear(index);
}

async function removeReply(): Promise<void> {
  const reply = removingReply.value;
  if (!reply || request.busy) return;
  confirmError.value = "";
  const index = (searching.value ? found.replies : replies.value).findIndex((item) => item.id === reply.id);
  const result = await send(`replies/${reply.id}/delete`, { revision: reply.revision });
  if (!result.ok && result.status === 409) {
    let fresh: QuickReply | null;
    try {
      fresh = await findReply(readGroupReplies, reply);
    } catch (error) {
      confirmError.value = errorMessage(error);
      return;
    }
    if (fresh) {
      // The fresh text is shown in the window: deleting it takes another explicit click.
      removingReply.value = fresh;
      confirmError.value = "Ответ изменил другой оператор: проверьте его текущий текст и подтвердите удаление снова.";
      void refresh();
      return;
    }
  } else if (!result.ok && result.status !== 404) {
    confirmError.value = result.message;
    return;
  }
  removingReply.value = null;
  if (result.ok) success("Ответ удалён.");
  else warning("Этого ответа уже нет: его удалил или перенёс другой оператор.");
  await refresh();
  await focusNear(index);
}

// The name field of a new group lives beside an open editor: only opening the created group asks.
function setCreating(value: boolean): void {
  groupError.value = "";
  creatingGroup.value = value;
}

async function createGroup(name: string): Promise<void> {
  if (request.busy) return;
  groupError.value = "";
  const result = await send<QuickReplyGroup>("reply-groups", { name });
  if (!result.ok) {
    groupError.value = result.message;
    return;
  }
  const group = result.value;
  creatingGroup.value = false;
  remember([group]);
  success(`Группа /${group.name} создана.`);
  void loadGroups();
  // A reply being edited meanwhile is not dropped: opening the new group asks first.
  guard(() => {
    scope.value = "catalog";
    choose(group);
    void focusList();
  });
}

function setRenaming(value: boolean): void {
  groupError.value = "";
  renamingGroup.value = value;
}

async function renameGroup(name: string): Promise<void> {
  const group = selected.value;
  if (!group || request.busy) return;
  groupError.value = "";
  const result = await send(`reply-groups/${group.id}/rename`, { name, revision: group.revision });
  if (selected.value?.id !== group.id) return;
  if (!result.ok) {
    if (result.status === 404) {
      groupGone(group);
    } else if (result.status === 409 && result.message === CONFLICT) {
      let fresh: QuickReplyGroup | null;
      try {
        fresh = await freshGroup(group.id);
      } catch (error) {
        groupError.value = errorMessage(error);
        return;
      }
      if (!fresh) groupGone(group);
      else groupError.value = `Группу изменил другой оператор, сейчас она называется /${fresh.name}. Сохраните новое название ещё раз или отмените.`;
    } else groupError.value = result.message;
    return;
  }
  // The renamed group may move beyond the loaded pages: its fresh revision is found by its name.
  const rows = await api<QuickReplyGroup[]>(`reply-groups?q=${encode(name.trim().replace(/^\//, ""))}`).catch(() => []);
  const fresh = rows.find((item) => item.id === group.id);
  if (fresh && selected.value?.id === group.id) {
    selected.value = fresh;
    remember([fresh]);
  }
  renamingGroup.value = false;
  success(`Группа переименована: /${selected.value?.name ?? group.name}.`);
  void loadGroups();
  // Renaming changes the revision of every reply in the group: their fresh revisions are needed.
  void loadReplies();
  await focusList({ menu: true });
}

function askRemoveGroup(): void {
  if (!selected.value || request.busy) return;
  clearNotice("warning");
  confirmError.value = "";
  removingGroup.value = selected.value;
}

async function removeGroup(): Promise<void> {
  const group = removingGroup.value;
  if (!group || request.busy) return;
  confirmError.value = "";
  const result = await send(`reply-groups/${group.id}/delete`, { revision: group.revision });
  if (!result.ok) {
    if (result.status === 404) {
      removingGroup.value = null;
      groupGone(group);
    } else if (result.status === 409 && result.message === CONFLICT) {
      let fresh: QuickReplyGroup | null;
      try {
        fresh = await freshGroup(group.id);
      } catch (error) {
        confirmError.value = errorMessage(error);
        return;
      }
      if (!fresh) {
        removingGroup.value = null;
        groupGone(group);
        return;
      }
      // The window shows the group's current name: deleting it takes another explicit click.
      removingGroup.value = fresh;
      confirmError.value = "Группу изменил другой оператор: проверьте её и подтвердите удаление снова.";
    } else confirmError.value = result.message;
    return;
  }
  removingGroup.value = null;
  success(`Группа /${group.name} удалена.`);
  if (selected.value?.id === group.id) {
    selected.value = null;
    replies.value = [];
    pane.value = "groups";
  }
  await loadGroups();
  await settled();
  groupList.value?.focus();
}

function clearSearch(): void {
  query.value = "";
  searchField.value?.focus();
}

function setOpen(value: boolean): void {
  if (!value) guard(() => { open.value = false; });
}

// Every opening starts at the catalog's first group with nothing being edited.
watch(open, (value) => {
  clearTimeout(searchTimer);
  clearTimeout(groupTimer);
  clearNotice();
  if (!value) {
    window.removeEventListener("beforeunload", keep);
    return;
  }
  groups.value = [];
  selected.value = null;
  replies.value = [];
  query.value = "";
  shownQuery = "";
  scope.value = "catalog";
  creatingGroup.value = false;
  renamingGroup.value = false;
  pane.value = "groups";
  paneBefore = "groups";
  closePanel();
  void loadGroups();
}, { immediate: true });

onBeforeUnmount(() => {
  clearTimeout(searchTimer);
  clearTimeout(groupTimer);
  repliesController?.abort();
  searchController?.abort();
  window.removeEventListener("beforeunload", keep);
});

const loadTargets = (q: string, offset: number, signal: AbortSignal) =>
  api<QuickReplyGroup[]>(`reply-groups?q=${encode(q)}&offset=${offset}`, { signal });
</script>

<template>
  <ModalDialog
    :open="open"
    title="Готовые ответы"
    description="Общий каталог проекта для всей команды. Изменения сами появляются в Telegram."
    content-class="dialog-catalog"
    :locked="request.busy"
    @update:open="setOpen"
  >
    <div class="catalog-toolbar mt-4 flex flex-wrap items-center gap-2" :data-editing="editing || undefined">
      <div class="catalog-search">
        <Icon name="search" />
        <input
          ref="search"
          v-model="query"
          type="search"
          maxlength="100"
          :placeholder="inGroup ? `Найти в /${selected?.name}…` : 'Найти группу или ответ…'"
          aria-label="Поиск в каталоге"
          :disabled="editing"
          @keydown.esc="query && ($event.stopPropagation(), clearSearch())"
        />
        <button v-if="query && !editing" type="button" class="quiet catalog-search-clear" aria-label="Очистить поиск" @click="clearSearch">
          <Icon name="close" class="size-4" />
        </button>
      </div>
      <div v-if="selected" class="catalog-scope" role="group" aria-label="Где искать">
        <button type="button" :aria-pressed="!inGroup" :disabled="editing" @click="scope = 'catalog'">Весь каталог</button>
        <button type="button" :aria-pressed="inGroup" :disabled="editing" class="max-w-48 truncate" @click="scope = 'group'">
          В /{{ selected.name }}
        </button>
      </div>
    </div>
    <div class="catalog-toast-region" role="status">
      <Transition name="catalog-toast">
        <p v-if="notice?.kind === 'success'" class="catalog-toast">
          <Icon name="check" class="size-4 shrink-0 text-success" />
          <span class="min-w-0">{{ notice.text }}</span>
        </p>
      </Transition>
    </div>
    <p v-if="notice?.kind === 'warning'" class="catalog-warning" role="alert">{{ notice.text }}</p>
    <div class="catalog-body" :data-pane="pane">
      <ReplyGroupList
        ref="group-list"
        :creating="creatingGroup"
        :groups="groups"
        :selected="selected?.id ?? null"
        :more="groupsMore"
        :loading="groupsLoading"
        :error="groupsError"
        :create-busy="request.busy"
        :create-error="groupError"
        @select="select"
        @create="createGroup"
        @more="loadGroups(true)"
        @retry="loadGroups()"
        @update:creating="setCreating"
      />
      <div class="catalog-detail" @keydown.esc="editing && ($event.stopPropagation(), cancelPanel())">
        <ReplyEditor
          v-if="panel.kind === 'editor'"
          :key="`${panel.reply?.id ?? 'new'}:${panel.group.id}`"
          v-model:dirty="editorDirty"
          :mode="panel.reply && !panel.missing ? 'edit' : 'create'"
          :group="panel.group.name"
          :initial="panel.reply?.text ?? ''"
          :busy="request.busy"
          :error="panelError"
          :current="conflict"
          @save="saveReply"
          @cancel="cancelPanel"
        />
        <ReplyMove
          v-else-if="panel.kind === 'move'"
          :reply="panel.reply"
          :from="panel.group"
          :load="loadTargets"
          :busy="request.busy"
          :error="panelError"
          @move="moveReply"
          @cancel="cancelPanel"
        />
        <ReplySearchResults
          v-else-if="searching"
          ref="results"
          :query="term"
          :groups="found.groups"
          :replies="found.replies"
          :names="names"
          :more-groups="found.moreGroups"
          :more-replies="found.moreReplies"
          :loading="found.loading"
          :error="found.error"
          :busy="request.busy"
          @open-group="openGroup"
          @action="act"
          @more-groups="runSearch('groups')"
          @more-replies="runSearch('replies')"
          @retry="runSearch()"
        />
        <ReplyList
          v-else-if="selected"
          ref="reply-list"
          :renaming="renamingGroup"
          :group="selected"
          :replies="replies"
          :more="repliesMore"
          :loading="repliesLoading"
          :error="repliesError"
          :rename-busy="request.busy"
          :rename-error="groupError"
          :busy="request.busy"
          :query="groupQuery"
          @add="add"
          @action="act"
          @rename="renameGroup"
          @remove-group="askRemoveGroup"
          @more="loadReplies(true)"
          @retry="loadReplies()"
          @back="pane = 'groups'"
          @update:renaming="setRenaming"
        />
        <div v-else class="catalog-empty">
          <p class="m-0">{{ groupsLoading ? "Загружаем каталог…" : groups.length ? "Выберите группу." : "Создайте первую группу: ответы хранятся в группах." }}</p>
        </div>
      </div>
    </div>
  </ModalDialog>
  <ConfirmDialog
    v-model:open="removingReplyOpen"
    title="Удалить ответ?"
    description="Ответ исчезнет из каталога у всей команды и из Telegram."
    confirm-label="Удалить ответ"
    busy-label="Удаляем…"
    :busy="request.busy"
    :error="confirmError"
    danger
    @confirm="removeReply"
  >
    <p class="catalog-version catalog-version-clamp mt-3">{{ removingReply?.text }}</p>
  </ConfirmDialog>
  <ConfirmDialog
    v-model:open="removingGroupOpen"
    :title="`Удалить группу /${removingGroup?.name ?? ''}?`"
    description="Удалить можно только пустую группу. Если в ней ещё есть ответы, сначала перенесите или удалите их."
    confirm-label="Удалить группу"
    busy-label="Удаляем…"
    :busy="request.busy"
    :error="confirmError"
    danger
    @confirm="removeGroup"
  />
  <ConfirmDialog
    v-model:open="discardOpen"
    title="Не сохранять изменения?"
    description="Текст ответа изменён, но не сохранён. Если уйти, изменения пропадут."
    confirm-label="Не сохранять"
    cancel-label="Вернуться к ответу"
    danger
    @confirm="discard"
    @close-auto-focus="discardClosed"
  />
</template>
