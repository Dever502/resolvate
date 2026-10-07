import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, GENERIC_ERROR, NO_PROJECT, request } from "./client";

function respond(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

const context = { csrf: "token", project: "p1", generation: 3 };

describe("request", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prefixes project paths and sends CSRF, JSON and idempotency headers", async () => {
    const fetch = vi.fn(async () => respond(200, { ok: true }));
    vi.stubGlobal("fetch", fetch);
    await request("tickets/sync", { method: "POST", data: { a: 1 }, key: "k" }, context, () => undefined);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/console/projects/p1/tickets/sync");
    expect(init.headers).toEqual({ "X-CSRF-Token": "token", "Content-Type": "application/json", "X-Idempotency-Key": "k" });
    expect(init.body).toBe('{"a":1}');
    expect(init.credentials).toBe("same-origin");
  });

  it("keeps installation paths and sends no CSRF header on GET", async () => {
    const fetch = vi.fn(async () => respond(200, []));
    vi.stubGlobal("fetch", fetch);
    await request("projects", {}, context, () => undefined);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/console/projects");
    expect(init.headers).toEqual({});
  });

  it("refuses project paths without a project", async () => {
    await expect(request("folders", {}, { ...context, project: null }, () => undefined)).rejects.toThrow(NO_PROJECT);
  });

  it("uses the server detail, or a generic text for non-JSON errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(409, { detail: "Конфликт." })));
    await expect(request("projects", {}, context, () => undefined)).rejects.toMatchObject({ message: "Конфликт.", status: 409 });
    vi.stubGlobal("fetch", vi.fn(async () => respond(502, "<html>Bad Gateway</html>")));
    await expect(request("projects", {}, context, () => undefined)).rejects.toMatchObject({ message: GENERIC_ERROR, status: 502 });
  });

  it("reports 401 with the generation the request was sent in, except for login", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(401, { detail: "Войдите в панель." })));
    const unauthorized = vi.fn();
    await expect(request("projects", {}, context, unauthorized)).rejects.toBeInstanceOf(ApiError);
    expect(unauthorized).toHaveBeenCalledWith(3);
    unauthorized.mockClear();
    await expect(request("login", { method: "POST", data: {} }, context, unauthorized)).rejects.toBeInstanceOf(ApiError);
    expect(unauthorized).not.toHaveBeenCalled();
  });
});
