<script setup lang="ts">
import { TooltipContent, TooltipPortal, TooltipRoot, TooltipTrigger } from "reka-ui";
import { useId } from "vue";

// A button whose only content is an icon (the default slot). `label` is its accessible name and is
// shown as a tooltip on hover and on keyboard focus; a native title shows on hover only.
// An optional `description` (limits, formats) follows the label in the tooltip and describes the button.
defineOptions({ inheritAttrs: false });
withDefaults(defineProps<{ label: string; description?: string }>(), { description: "" });
const id = useId();
</script>

<template>
  <TooltipRoot>
    <TooltipTrigger as-child>
      <!-- The label already names the button: the tooltip must not repeat it as a description. -->
      <button
        type="button"
        v-bind="$attrs"
        :aria-label="label"
        :aria-describedby="description ? `${id}-description` : undefined"
      >
        <slot />
        <span v-if="description" :id="`${id}-description`" class="sr-only">{{ description }}</span>
      </button>
    </TooltipTrigger>
    <TooltipPortal>
      <TooltipContent class="tooltip" side="top" :side-offset="6" :collision-padding="8" aria-hidden="true">
        {{ label }}<template v-if="description"><br><span class="tooltip-note">{{ description }}</span></template>
      </TooltipContent>
    </TooltipPortal>
  </TooltipRoot>
</template>
