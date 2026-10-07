<script setup lang="ts">
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";
import { computed, onMounted, onUnmounted, ref, useTemplateRef, watch } from "vue";
import { useImageGestures, ZOOM_STEP } from "../../composables/useImageGestures";
import { useChatStore } from "../../stores/chat";
import Icon from "../ui/Icon.vue";

// Full-size photo or sticker from the history: wheel or pinch zooms around the pointer, dragging
// moves a zoomed image, +/−/0 work from the keyboard; Esc or a click beside the image closes it.
const chat = useChatStore();
const stage = useTemplateRef<HTMLElement>("stage");
const picture = useTemplateRef<HTMLImageElement>("picture");
const failed = ref(false);
const open = computed({
  get: () => chat.viewer !== null,
  set: (value) => {
    if (!value) chat.viewer = null;
  },
});
const gestures = useImageGestures(stage, picture, () => {
  chat.viewer = null;
});

watch(() => chat.viewer, () => {
  failed.value = false;
  gestures.reset();
});

function onResize(): void {
  if (open.value) gestures.clamp();
}
onMounted(() => window.addEventListener("resize", onResize));
onUnmounted(() => window.removeEventListener("resize", onResize));
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-black/80" />
      <DialogContent class="image-viewer" @keydown="gestures.onKeyDown">
        <DialogTitle class="sr-only">Просмотр изображения</DialogTitle>
        <DialogDescription class="sr-only">Колесо или жест — масштаб, перетаскивание — перемещение.</DialogDescription>
        <div class="image-toolbar">
          <button type="button" aria-label="Уменьшить" @click="gestures.zoomBy(1 / ZOOM_STEP)"><Icon name="minus" /></button>
          <button type="button" title="Подогнать под окно" @click="gestures.reset()">{{ gestures.percent.value }}</button>
          <button type="button" aria-label="Увеличить" @click="gestures.zoomBy(ZOOM_STEP)"><Icon name="plus" /></button>
          <span class="flex-1 text-[.8125rem] text-[#c6c9cf] narrow:hidden" aria-hidden="true">Колесо или жест — масштаб · перетаскивание — перемещение</span>
          <button type="button" class="ml-auto" aria-label="Закрыть изображение" @click="open = false"><Icon name="close" /></button>
        </div>
        <div
          ref="stage"
          class="image-stage"
          :class="{ zoomed: gestures.zoomed.value }"
          @wheel="gestures.onWheel"
          @pointerdown="gestures.onPointerDown"
          @pointermove="gestures.onPointerMove"
          @pointerup="gestures.onPointerEnd"
          @pointercancel="gestures.onPointerEnd"
          @lostpointercapture="gestures.onPointerEnd"
        >
          <img
            v-if="chat.viewer"
            ref="picture"
            :src="chat.viewer"
            alt="Изображение из переписки"
            draggable="false"
            :style="gestures.transform.value"
            @load="gestures.reset()"
            @error="failed = true"
          />
        </div>
        <p v-if="failed" class="absolute inset-x-4 top-[45%] text-center" role="alert">
          Изображение недоступно. Закройте просмотр и обновите переписку.
        </p>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
