import { defineStore } from "pinia";
import { ref } from "vue";
import {
  ApiError,
  readResult,
  request,
  responseError,
  type ApiOptions,
} from "../api/client";
import type { Account, SessionPayload } from "../api/types";

export type SessionStatus = "checking" | "signed-out" | "signed-in";

export const OFFLINE = "Нет связи с сервером.";
export const RETRYING = "Повторяем проверку входа…";
/** Delays between session re-checks after a network or server error, in milliseconds. */
export const RETRY_DELAYS = [3000, 6000, 12000, 30000];
/** A session check not finished in this time, response body included, counts as a lost connection. */
export const CHECK_TIMEOUT = 10000;

export function fetchSession(signal: AbortSignal): Promise<Response> {
  return fetch("/console/me", { credentials: "same-origin", headers: { Accept: "application/json" }, signal });
}

export const useSessionStore = defineStore("session", () => {
  const status = ref<SessionStatus>("checking");
  const account = ref<Account | null>(null);
  const csrf = ref("");
  /** Changes on every sign-in and sign-out: answers to older requests must not act on a new session. */
  const generation = ref(0);
  /** Message on the sign-in form: why the session check failed, or a confirmation. */
  const notice = ref("");
  const noticeIsSuccess = ref(false);
  const endHandlers = new Set<() => void>();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryAttempt = 0;

  function stopRetry(): void {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    window.removeEventListener("online", retryNow);
  }
  function retryNow(): void {
    stopRetry();
    const controller = new AbortController();
    void check(fetchSession(controller.signal), controller);
  }
  function scheduleRetry(): void {
    stopRetry();
    const delay = RETRY_DELAYS[Math.min(retryAttempt, RETRY_DELAYS.length - 1)];
    retryAttempt++;
    retryTimer = setTimeout(retryNow, delay);
    window.addEventListener("online", retryNow);
  }

  function signIn(payload: SessionPayload): void {
    stopRetry();
    retryAttempt = 0;
    generation.value++;
    account.value = payload.account;
    csrf.value = payload.csrf;
    notice.value = "";
    noticeIsSuccess.value = false;
    status.value = "signed-in";
  }

  function signOut(message = "", success = false): void {
    stopRetry();
    generation.value++;
    account.value = null;
    csrf.value = "";
    notice.value = message;
    noticeIsSuccess.value = success;
    status.value = "signed-out";
    for (const handler of endHandlers) handler();
  }

  /** Workspace stores register here to drop their data when the session ends. */
  function onSessionEnd(handler: () => void): () => void {
    endHandlers.add(handler);
    return () => endHandlers.delete(handler);
  }

  // Only 401 ends the session, and only for a request sent in the current session.
  function unauthorized(sentIn: number): void {
    if (sentIn === generation.value && status.value === "signed-in") signOut();
  }

  function api<T>(path: string, options: ApiOptions = {}, project: string | null = null): Promise<T> {
    return request<T>(path, options, { csrf: csrf.value, project, generation: generation.value }, unauthorized);
  }

  /**
   * Resolves the page's session check; network and server errors keep retrying. A check that stalls,
   * before or after the headers, is aborted through `controller` after CHECK_TIMEOUT and retried too.
   */
  async function check(response: Promise<Response>, controller: AbortController): Promise<void> {
    const sentIn = generation.value;
    let error: unknown;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      // Racing the deadline also covers the body: readResult() turns an aborted body into {}.
      const [answer, result] = await Promise.race([
        response.then(async (answer) => [answer, await readResult(answer)] as const),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => {
            reject(new Error("The session check timed out."));
            controller.abort();
          }, CHECK_TIMEOUT);
        }),
      ]);
      if (sentIn !== generation.value) return;
      if (answer.ok) {
        signIn(result as SessionPayload);
        return;
      }
      error = responseError(answer, result);
    } catch (caught) {
      error = caught;
    } finally {
      clearTimeout(deadline);
    }
    if (sentIn !== generation.value) return; // Signed in with the form while the check was pending.
    status.value = "signed-out";
    if (error instanceof ApiError && error.status === 401) {
      stopRetry();
      retryAttempt = 0;
      notice.value = "";
      return;
    }
    notice.value = `${error instanceof ApiError ? error.message : OFFLINE} ${RETRYING}`;
    noticeIsSuccess.value = false;
    scheduleRetry();
  }

  async function login(loginName: string, password: string): Promise<void> {
    const payload = await request<SessionPayload>(
      "login",
      { method: "POST", data: { login: loginName, password } },
      { csrf: "", project: null, generation: generation.value },
      () => undefined,
    );
    signIn(payload);
  }

  async function logout(): Promise<void> {
    await api("logout", { method: "POST" });
    signOut();
  }

  return {
    status, account, csrf, generation, notice, noticeIsSuccess,
    api, check, login, logout, signIn, signOut, onSessionEnd,
  };
});
