<script setup lang="ts">
import { TooltipContent, TooltipPortal, TooltipRoot, TooltipTrigger } from "reka-ui";

// A button whose only content is an icon (the default slot). `label` is its accessible name and is
// shown as a tooltip on hover and on keyboard focus; a native title shows on hover only.
defineOptions({ inheritAttrs: false });
defineProps<{ label: string }>();
</script>

<template>
  <TooltipRoot>
    <TooltipTrigger as-child>
      <!-- The label already names the button: the tooltip must not repeat it as a description. -->
      <button type="button" v-bind="$attrs" :aria-label="label" :aria-describedby="undefined">
        <slot />
      </button>
    </TooltipTrigger>
    <TooltipPortal>
      <TooltipContent class="tooltip" side="top" :side-offset="6" :collision-padding="8" aria-hidden="true">
        {{ label }}
      </TooltipContent>
    </TooltipPortal>
  </TooltipRoot>
</template>
