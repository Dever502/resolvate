<script setup lang="ts">
import { computed, useTemplateRef } from "vue";
import { ATTEMPT_AGE_WARNING, type SendAttempt } from "../../stores/chat";

// A send whose answer never came (a lost connection, the deadline, a proxy error). The server may have
// taken the message already, so the operator decides: send the same copy again under the same key (the
// server answers with the message it saved, or saves it once) or give it up. Edits of the reply box are
// not part of this attempt.
const props = defineProps<{ attempt: SendAttempt; sending: boolean }>();
const emit = defineEmits<{ retry: []; forget: [] }>();
const retryButton = useTemplateRef<HTMLButtonElement>("retry");
// The server keeps a key as long as its message: an archived dialogue's history is removed after a while.
const old = computed(() => Date.now() - props.attempt.createdAt > ATTEMPT_AGE_WARNING);
const copy = computed(() => {
  const flat = props.attempt.text.replace(/\s+/g, " ").trim();
  const text = flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
  return [text, props.attempt.file?.name].filter(Boolean).join(" · ");
});

defineExpose({ focusRetry: () => retryButton.value?.focus() });
</script>

<template>
  <section class="send-attempt" aria-label="Отправка с неизвестным результатом">
    <!-- A new alert per failed request: a retry that fails with the same reason is announced again. -->
    <p v-if="attempt.state === 'unknown'" :key="attempt.tries" class="m-0" role="alert">
      <strong>Результат отправки неизвестен.</strong> {{ attempt.reason }}
    </p>
    <p v-else class="m-0"><strong>Повторяем отправку…</strong></p>
    <p class="muted m-0">
      Сервер мог уже принять это сообщение. «Повторить отправку» пошлёт его ещё раз под тем же ключом —
      дубликата не будет. Правки в поле ответа в этот повтор не попадут.
    </p>
    <p v-if="!attempt.persisted" class="m-0">
      <strong>Эта отправка не сохранена в браузере:</strong> после обновления страницы её уже не повторить безопасно.
    </p>
    <p v-if="old" class="m-0">
      Отправке больше суток. Если диалог за это время ушёл в архив, сервер мог забыть её ключ — проверьте историю
      перед повтором.
    </p>
    <p class="send-attempt-copy">{{ copy }}</p>
    <div class="flex flex-wrap gap-2">
      <button ref="retry" type="button" class="secondary" :aria-disabled="sending || undefined" @click="!sending && emit('retry')">
        {{ sending ? "Повторяем…" : "Повторить отправку" }}
      </button>
      <button type="button" class="quiet" :aria-disabled="sending || undefined" @click="!sending && emit('forget')">Не повторять</button>
    </div>
  </section>
</template>
