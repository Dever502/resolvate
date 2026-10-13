// What this tab keeps for its next load (sessionStorage, so each tab keeps its own and nothing
// outlives the tab), tied to the account and read after the session check: where it was (the project
// and the open dialogue, only ids), and the draft texts the page was left with before their writes
// reached the browser's storage (lib/workStore.ts merges them back).

const KEY = "resolvate.workspace";
const UNSAVED = "resolvate.unsaved";

export interface Navigation {
  account: string;
  project: string | null;
  ticket: string | null;
}

const id = (value: unknown): value is string | null => value === null || (typeof value === "string" && value.length > 0 && value.length <= 64);

/** The account's last place in this tab, or null (none, another account, or storage that refuses). */
export function readNavigation(account: string): Navigation | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as { v?: unknown } & Partial<Navigation> | null;
    if (!value || value.v !== 1 || value.account !== account || !id(value.project ?? null) || !id(value.ticket ?? null)) return null;
    return { account, project: value.project ?? null, ticket: value.project ? value.ticket ?? null : null };
  } catch {
    return null;
  }
}

export function writeNavigation(place: Navigation): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ v: 1, ...place }));
  } catch {
    // A tab that keeps no storage starts from the first project after a reload, as before.
  }
}

/** A draft's text the page was left with while its write was still on the way. */
export interface UnsavedText {
  account: string;
  project: string;
  ticket: string;
  text: string;
  /** When it was typed: a draft stored later (by another tab) wins over it. */
  at: number;
}

function validText(value: unknown): value is UnsavedText {
  const item = value as UnsavedText | null;
  return Boolean(item) && id(item!.account) && id(item!.project) && id(item!.ticket) && item!.account !== null
    && item!.project !== null && item!.ticket !== null && typeof item!.text === "string" && Number.isFinite(item!.at);
}

/** Replaces the texts kept for the next load (synchronous: called as the page is left). */
export function keepUnsaved(texts: UnsavedText[]): void {
  try {
    if (texts.length) sessionStorage.setItem(UNSAVED, JSON.stringify({ v: 1, texts }));
    else sessionStorage.removeItem(UNSAVED);
  } catch {
    // Nothing kept: the drafts' own writes are all there is.
  }
}

/** The account's kept texts, taken out of the tab: they are merged once, another account's are dropped. */
export function takeUnsaved(account: string): UnsavedText[] {
  try {
    const value = JSON.parse(sessionStorage.getItem(UNSAVED) ?? "null") as { v?: unknown; texts?: unknown } | null;
    sessionStorage.removeItem(UNSAVED);
    if (value?.v !== 1 || !Array.isArray(value.texts)) return [];
    return value.texts.filter((item): item is UnsavedText => validText(item) && item.account === account);
  } catch {
    return [];
  }
}

/** An explicit sign-out: the tab keeps nothing of the account. */
export function clearNavigation(): void {
  try {
    sessionStorage.removeItem(KEY);
    sessionStorage.removeItem(UNSAVED);
  } catch {
    // Nothing kept, nothing to clear.
  }
}
