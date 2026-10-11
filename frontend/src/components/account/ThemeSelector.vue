<script setup lang="ts">
import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from "reka-ui";
import { useId } from "vue";
import { THEME_LABELS, useThemeStore, type ThemePreference } from "../../stores/theme";
import Icon from "../ui/Icon.vue";
import type { IconName } from "../ui/icons";

const theme = useThemeStore();
const id = useId();
const options: { value: ThemePreference; icon: IconName }[] = [
  { value: "system", icon: "monitor" },
  { value: "light", icon: "sun" },
  { value: "dark", icon: "moon" },
];

function select(value: unknown): void {
  if (value === "system" || value === "light" || value === "dark") theme.setPreference(value);
}

// Up/Down, Home/End and selection stay with Reka's menu. Left/Right also move focus
// within this horizontal row; moving focus alone does not change the saved preference.
function horizontalNavigation(event: KeyboardEvent): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const items = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  const index = items.indexOf(event.target as HTMLElement);
  if (index < 0) return;
  event.preventDefault();
  event.stopPropagation();
  items[(index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length]?.focus();
}
</script>

<template>
  <div class="account-theme-row">
    <span :id="id" class="text-sm">Тема</span>
    <DropdownMenuRadioGroup class="account-theme-options" :aria-labelledby="id" :model-value="theme.preference"
      @update:model-value="select" @keydown="horizontalNavigation">
      <DropdownMenuRadioItem v-for="option in options" :key="option.value" :value="option.value"
        class="account-theme-option" :aria-label="THEME_LABELS[option.value]" :title="THEME_LABELS[option.value]"
        :text-value="THEME_LABELS[option.value]" @select.prevent>
        <Icon :name="option.icon" class="size-[18px]" />
      </DropdownMenuRadioItem>
    </DropdownMenuRadioGroup>
  </div>
</template>
