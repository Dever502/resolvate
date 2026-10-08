<script setup lang="ts">
import type { useSidebarResize } from "../../composables/useSidebarResize";
import type { UnwrapNestedRefs } from "vue";

defineProps<{ resize: UnwrapNestedRefs<ReturnType<typeof useSidebarResize>> }>();
</script>

<template>
  <div
    class="sidebar-resizer narrow:hidden"
    role="separator"
    :tabindex="resize.disabled ? -1 : 0"
    aria-label="Ширина списка диалогов"
    aria-orientation="vertical"
    aria-controls="ticket-sidebar"
    :aria-valuemin="Math.round(resize.limits.min)"
    :aria-valuemax="Math.round(resize.limits.max)"
    :aria-valuenow="Math.round(resize.width)"
    :aria-valuetext="`${Math.round(resize.width)} пикселей`"
    :aria-disabled="resize.disabled"
    title="Потяните для изменения ширины; двойной щелчок — сброс"
    @pointerdown="resize.onPointerDown"
    @pointermove="resize.onPointerMove"
    @pointerup="resize.onPointerEnd"
    @pointercancel="resize.onPointerEnd"
    @lostpointercapture="resize.onPointerEnd"
    @keydown="resize.onKeyDown"
    @dblclick="resize.onDoubleClick"
  />
</template>
