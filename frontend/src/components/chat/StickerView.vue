<script setup lang="ts">
import type { AnimationConfigWithData, AnimationItem } from "lottie-web";
import { computed, onMounted, onUnmounted, ref, useTemplateRef } from "vue";
import { useChatStore } from "../../stores/chat";

// A Telegram sticker, loaded only when it scrolls into view. WebP opens in the viewer, WebM and
// TGS play on request: no endless loops or a page of players running while the history is read.
// TGS needs the light canvas build of lottie-web (no expression engine, so no eval), loaded on
// first use from this installation.
const props = defineProps<{ src: string; mime: string; emoji: string }>();
const chat = useChatStore();
const root = useTemplateRef<HTMLElement>("root");
const canvas = useTemplateRef<HTMLCanvasElement>("canvas");
const video = useTemplateRef<HTMLVideoElement>("video");
const visible = ref(false);
const ready = ref(false);
const failed = ref(false);
const name = computed(() => (props.emoji ? `Стикер ${props.emoji}` : "Стикер"));
const image = computed(() => props.mime.startsWith("image/"));
const tgs = computed(() => props.mime === "application/x-tgsticker");
const webm = computed(() => props.mime === "video/webm");
const controller = new AbortController();
let observer: IntersectionObserver | null = null;
let animation: AnimationItem | null = null;

function fail(): void {
  pause();
  failed.value = true;
  ready.value = false;
}

function pause(): void {
  video.value?.pause();
  animation?.pause();
}

async function loadAnimation(): Promise<void> {
  const response = await fetch(props.src, { signal: controller.signal, credentials: "same-origin" });
  if (!response.ok) throw new Error("unavailable");
  const animationData: unknown = await response.json();
  const { default: lottie } = await import("lottie-web/build/player/lottie_light_canvas");
  if (controller.signal.aborted || !canvas.value) return;
  // Present in the build but missing from its types; a worker from a blob: URL would break the CSP.
  (lottie as typeof lottie & { useWebWorker(enabled: boolean): void }).useWebWorker(false);
  // Drawn into our own canvas, as in the classic console; the types insist on a container anyway.
  const loaded = lottie.loadAnimation<"canvas">({
    renderer: "canvas", animationData, autoplay: false, loop: false,
    rendererSettings: { context: canvas.value.getContext("2d")!, clearCanvas: true },
  } as AnimationConfigWithData<"canvas">);
  animation = loaded;
  loaded.addEventListener("data_failed", fail);
  loaded.addEventListener("error", fail);
  loaded.addEventListener("DOMLoaded", () => animation?.goToAndStop(0, true));
  ready.value = true;
}

function start(): void {
  if (webm.value || image.value) {
    ready.value = true; // The element itself loads the file; its error event marks a failure.
    return;
  }
  if (!tgs.value) {
    failed.value = true;
    return;
  }
  loadAnimation().catch((error: unknown) => {
    if (!(error instanceof DOMException && error.name === "AbortError")) fail();
  });
}

function activate(): void {
  if (!ready.value || failed.value) return;
  if (image.value) chat.viewer = props.src;
  else if (video.value) {
    if (!video.value.paused) video.value.pause();
    else video.value.play().catch(fail);
  } else if (animation) {
    if (animation.isPaused) animation.goToAndPlay(0, true);
    else animation.pause();
  }
}

function onVisibility(): void {
  if (document.hidden) pause();
}

onMounted(() => {
  observer = new IntersectionObserver((entries) => {
    const seen = entries.some((entry) => entry.isIntersecting);
    if (seen && !visible.value) {
      visible.value = true;
      start();
    } else if (!seen) pause();
  });
  if (root.value) observer.observe(root.value);
  document.addEventListener("visibilitychange", onVisibility);
});

onUnmounted(() => {
  controller.abort();
  observer?.disconnect();
  document.removeEventListener("visibilitychange", onVisibility);
  pause();
  animation?.destroy();
  animation = null;
});
</script>

<template>
  <div ref="root" class="block w-48 max-w-full">
    <button
      class="sticker-preview"
      type="button"
      :aria-label="image ? 'Открыть стикер' : 'Воспроизвести стикер'"
      :aria-disabled="!ready || failed || undefined"
      @click="activate"
    >
      <template v-if="visible && !failed">
        <img v-if="image" :src="src" :alt="name" @error="fail" />
        <video v-else-if="webm" ref="video" :src="src" muted playsinline preload="metadata" @error="fail" />
        <canvas v-else-if="tgs" ref="canvas" width="512" height="512" aria-hidden="true" />
      </template>
    </button>
    <span class="muted mt-1 block text-xs">{{ failed ? "Стикер недоступен" : name }}</span>
  </div>
</template>
