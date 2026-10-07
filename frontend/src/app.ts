import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { useSessionStore } from "./stores/session";

/**
 * Mounts the console; `session` is the GET /console/me request started by the entry script and
 * `controller` aborts it.
 */
export function start(session: Promise<Response>, controller: AbortController): void {
  const pinia = createPinia();
  const app = createApp(App).use(pinia);
  void useSessionStore(pinia).check(session, controller);
  app.mount("#app");
}
