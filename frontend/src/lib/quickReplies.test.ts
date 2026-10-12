import { describe, expect, it, vi } from "vitest";
import type { QuickReply, QuickReplyGroup } from "../api/types";
import { PAGE, findGroup, findReply, readPages } from "./quickReplies";

const replies = (from: number, count: number, groupId = "g1"): QuickReply[] =>
  Array.from({ length: count }, (_, index) => ({ id: String(from + index), text: `Ответ ${from + index}`, group_id: groupId, revision: 0 }));
const groups = (from: number, count: number): QuickReplyGroup[] =>
  Array.from({ length: count }, (_, index) => ({ id: `g${from + index}`, name: `группа_${from + index}`, revision: 0 }));

describe("catalog paging", () => {
  it("reads as many pages as asked, stops at a short one and tells whether more may follow", async () => {
    const read = vi.fn(async (offset: number) => replies(offset + 1, offset < 100 ? PAGE : 7));
    expect(await readPages(read, 2)).toEqual({ rows: replies(1, 100), more: true });
    expect(read.mock.calls.map(([offset]) => offset)).toEqual([0, 50]);
    read.mockClear();
    const all = await readPages(read, 5);
    expect(all).toEqual({ rows: replies(1, 107), more: false });
    expect(read.mock.calls.map(([offset]) => offset)).toEqual([0, 50, 100]);
    // "More" continues after the rows already shown.
    read.mockClear();
    expect(await readPages(read, 1, replies(1, 50))).toEqual({ rows: replies(1, 100), more: true });
    expect(read.mock.calls.map(([offset]) => offset)).toEqual([50]);
  });

  it("finds a reply's current version in its own group and stops once the ids pass it", async () => {
    const read = vi.fn(async (groupId: string, offset: number) => replies(offset + 1, PAGE, groupId));
    const fresh = await findReply(read, { id: "77", text: "старый", group_id: "g2", revision: 0 });
    expect(fresh).toEqual({ id: "77", text: "Ответ 77", group_id: "g2", revision: 0 });
    expect(read.mock.calls).toEqual([["g2", 0], ["g2", 50]]);
    // Ids are sorted: a page past the id means the reply left the group.
    const gone = vi.fn(async (groupId: string, offset: number) => replies(offset + 100, PAGE, groupId));
    expect(await findReply(gone, { id: "77", text: "", group_id: "g2", revision: 0 })).toBeNull();
    expect(gone).toHaveBeenCalledTimes(1);
    expect(await findReply(async () => replies(1, 3), { id: "77", text: "", group_id: "g1", revision: 0 })).toBeNull();
  });

  it("finds a group by id on a later page, or tells that it is gone", async () => {
    const read = vi.fn(async (offset: number) => (offset < 100 ? groups(offset, PAGE) : groups(offset, 4)));
    expect(await findGroup(read, "g120")).toBeNull();
    expect(read.mock.calls.map(([offset]) => offset)).toEqual([0, 50, 100]);
    expect(await findGroup(read, "g61")).toEqual({ id: "g61", name: "группа_61", revision: 0 });
  });
});
