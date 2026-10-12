import type { QuickReply, QuickReplyGroup } from "../api/types";

// Paging of the quick replies catalog API (src/resolvate/quick_reply_catalog.py): every list
// answers at most PAGE rows; groups come sorted by name, replies by id.
export const PAGE = 50;

/** Reads up to `pages` pages after `rows` (stopping at a short one); `more` tells whether another may follow. */
export async function readPages<T>(
  read: (offset: number) => Promise<T[]>,
  pages: number,
  rows: T[] = [],
): Promise<{ rows: T[]; more: boolean }> {
  let last: T[] = [];
  for (let page = 0; page < pages; page++) {
    last = await read(rows.length);
    rows = [...rows, ...last];
    if (last.length < PAGE) return { rows, more: false };
  }
  return { rows, more: last.length === PAGE };
}

/**
 * The server's current version of a reply, read from its group's pages up to its id; null when the
 * reply has left the group (deleted or moved). `read` gives a page of the group's replies.
 */
export async function findReply(
  read: (groupId: string, offset: number) => Promise<QuickReply[]>,
  reply: QuickReply,
  limit = 40,
): Promise<QuickReply | null> {
  const id = Number(reply.id);
  for (let page = 0; page < limit; page++) {
    const rows = await read(reply.group_id, page * PAGE);
    const fresh = rows.find((item) => item.id === reply.id);
    if (fresh) return fresh;
    if (rows.length < PAGE || Number(rows.at(-1)?.id) > id) return null;
  }
  return null;
}

/** A group by id wherever it sorts now (a rename moves it); null when it is gone. */
export async function findGroup(
  read: (offset: number) => Promise<QuickReplyGroup[]>,
  id: string,
  limit = 40,
): Promise<QuickReplyGroup | null> {
  for (let page = 0; page < limit; page++) {
    const rows = await read(page * PAGE);
    const found = rows.find((item) => item.id === id);
    if (found) return found;
    if (rows.length < PAGE) return null;
  }
  return null;
}
