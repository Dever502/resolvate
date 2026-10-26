<script setup lang="ts">
import {
  DropdownMenuContent, DropdownMenuItemIndicator, DropdownMenuPortal, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuRoot, DropdownMenuTrigger,
} from "reka-ui";
import { computed, useId } from "vue";
import Icon from "./Icon.vue";
import type { IconName } from "./icons";

export interface MenuOption {
  value: string;
  label: string;
}

// One choice from a list, applied at once (the current project, the folder of a dialogue).
// A Reka menu button with radio items: Reka Select would add an inline style element, which the
// console CSP blocks. Arrows, Home/End and typing move through the choices, Enter or Space picks one,
// Esc closes, and focus returns to the button.
const props = withDefaults(defineProps<{
  modelValue: string;
  options: MenuOption[];
  /** Names the choice; the button announces it together with the current value. */
  label: string;
  placeholder?: string;
  disabled?: boolean;
  /** "chrome" for the dark app bar: the chevron follows the value and turns up while the menu is open. */
  tone?: "field" | "chrome";
  /** An icon-only 44×44 button (a narrow header): the value is not shown, it still names the button. */
  icon?: IconName | "";
  /** Where the menu lines up with the button. */
  align?: "start" | "end";
}>(), { placeholder: "", disabled: false, tone: "field", icon: "", align: "start" });
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const id = useId();
const shown = computed(() => props.options.find((option) => option.value === props.modelValue)?.label || props.placeholder);
</script>

<template>
  <div class="min-w-0">
    <DropdownMenuRoot :modal="false">
      <!-- Named through aria-labelledby only: a visible copy would be read twice. -->
      <span :id="`${id}-label`" hidden>{{ label }}</span>
      <DropdownMenuTrigger
        class="menu-select"
        :class="{ 'menu-select-chrome': tone === 'chrome', 'menu-select-icon': icon }"
        :disabled="disabled"
        :aria-labelledby="`${id}-label ${id}-value`"
      >
        <!-- In the app bar the value keeps its own width, so the chevron follows it; the button still spans
             its column, and its free end opens the menu too. A field stretches the value instead. -->
        <template v-if="icon">
          <Icon :name="icon" />
          <span :id="`${id}-value`" class="sr-only">{{ shown }}</span>
        </template>
        <template v-else>
          <span :id="`${id}-value`" class="min-w-0 truncate text-left" :class="{ 'flex-1': tone !== 'chrome' }">{{ shown }}</span>
          <Icon name="chevron" class="size-4 shrink-0" :class="{ 'menu-select-chevron': tone === 'chrome' }" />
        </template>
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent class="menu" :align="align" :side-offset="6" :collision-padding="8" loop>
          <DropdownMenuRadioGroup :model-value="modelValue" @update:model-value="(value) => emit('update:modelValue', String(value))">
            <DropdownMenuRadioItem
              v-for="option in options"
              :key="option.value"
              :value="option.value"
              :text-value="option.label"
              class="menu-item"
            >
              <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
              <DropdownMenuItemIndicator class="shrink-0">
                <Icon name="check" class="size-4" />
              </DropdownMenuItemIndicator>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
  </div>
</template>
