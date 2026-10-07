// Authenticated console API client; contracts are shared with the Telegram-backed services.

export const GENERIC_ERROR = "Запрос не выполнен. Повторите позже.";
export const NO_PROJECT = "Выберите доступный проект.";

// Paths served by the project runtime; the router forwards /console/projects/<id>/<path>.
const PROJECT_SCOPED = /^(folders(?:\/|$)|tickets(?:\/|$)|media\/|retry\/|replies(?:\?|$))/;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiOptions {
  method?: "GET" | "POST";
  data?: unknown;
  form?: FormData;
  key?: string;
  signal?: AbortSignal;
}

export interface RequestContext {
  csrf: string;
  project: string | null;
  /** Session generation at the moment the request was sent. */
  generation: number;
}

export type UnauthorizedHandler = (generation: number) => void;

export async function readResult(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export function responseError(response: Response, result: unknown): ApiError {
  const detail = (result as { detail?: unknown } | null)?.detail;
  return new ApiError(typeof detail === "string" ? detail : GENERIC_ERROR, response.status);
}

export async function request<T>(
  path: string,
  options: ApiOptions,
  context: RequestContext,
  onUnauthorized: UnauthorizedHandler,
): Promise<T> {
  if (PROJECT_SCOPED.test(path)) {
    if (!context.project) throw new ApiError(NO_PROJECT, 0);
    path = `projects/${context.project}/${path}`;
  }
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["X-CSRF-Token"] = context.csrf;
  if (options.data !== undefined) headers["Content-Type"] = "application/json";
  if (options.key) headers["X-Idempotency-Key"] = options.key;
  const response = await fetch(`/console/${path}`, {
    method,
    headers,
    credentials: "same-origin",
    signal: options.signal ?? null,
    body: options.form ?? (options.data !== undefined ? JSON.stringify(options.data) : null),
  });
  const result = await readResult(response);
  if (!response.ok) {
    if (response.status === 401 && path !== "login") onUnauthorized(context.generation);
    throw responseError(response, result);
  }
  return result as T;
}
