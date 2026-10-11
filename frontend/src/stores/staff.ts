import { defineStore } from "pinia";
import { ref } from "vue";
import type { Account } from "../api/types";
import { useSessionStore } from "./session";

export interface NewAccount {
  name: string;
  login: string;
  password: string;
  telegram_id: number | null;
}

/**
 * Console accounts of the installation, for its administrator (GET /console/accounts and the account
 * routes of src/resolvate/console.py, project_routes.py). The server checks every permission and rule;
 * after a change the list is reloaded.
 */
export const useStaffStore = defineStore("staff", () => {
  const session = useSessionStore();
  const accounts = ref<Account[]>([]);
  const loaded = ref(false);

  async function refresh(): Promise<void> {
    const generation = session.generation;
    const rows = await session.api<Account[]>("accounts");
    if (generation !== session.generation) return;
    accounts.value = rows;
    loaded.value = true;
  }

  async function follow(): Promise<void> {
    try {
      await refresh();
    } catch {
      // The change itself succeeded; the list is reloaded when the window opens again.
    }
  }

  /** A new operator account; it gets no project access by itself. */
  async function create(account: NewAccount): Promise<Account> {
    const created = await session.api<Account>("accounts", { method: "POST", data: { ...account, role: "operator" } });
    await follow();
    return created;
  }

  /** Switching an account off also ends all of its sessions (on the server). */
  async function setActive(account: Account, active: boolean): Promise<void> {
    await session.api(`accounts/${account.id}/${active ? "enable" : "disable"}`, { method: "POST" });
    await follow();
  }

  async function setTelegramId(account: Account, telegramId: number | null): Promise<void> {
    await session.api(`accounts/${account.id}/identity/telegram`, { method: "POST", data: { telegram_id: telegramId } });
    await follow();
  }

  function reset(): void {
    accounts.value = [];
    loaded.value = false;
  }
  session.onSessionEnd(reset);

  return { accounts, loaded, refresh, create, setActive, setTelegramId, reset };
});
