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

export function fetchSession(): Promise<Response> {
  return fetch("/console/me", { credentials: "same-origin", headers: { Accept: "application/json" } });
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
    void check(fetchSession());
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

  /** Resolves the page's session check; network and server errors keep retrying. */
  async function check(response: Promise<Response>): Promise<void> {
    const sentIn = generation.value;
    let error: unknown;
    try {
      const answer = await response;
      const result = await readResult(answer);
      if (sentIn !== generation.value) return;
      if (answer.ok) {
        signIn(result as SessionPayload);
        return;
      }
      error = responseError(answer, result);
    } catch (caught) {
      error = caught;
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
