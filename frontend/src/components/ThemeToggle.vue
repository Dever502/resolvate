<script setup lang="ts">
import { computed } from "vue";
import { THEME_LABELS, useThemeStore, type ThemePreference } from "../stores/theme";
import Icon from "./ui/Icon.vue";
import type { IconName } from "./ui/icons";

// The icon shows the current theme; the label names it and the next one.
const ICONS: Record<ThemePreference, IconName> = { system: "monitor", light: "sun", dark: "moon" };

const theme = useThemeStore();
const label = computed(() => THEME_LABELS[theme.preference]);
</script>

<template>
  <button
    class="quiet min-h-11 min-w-11 shrink-0 p-2"
    type="button"
    data-theme-toggle
    :data-theme-preference="theme.preference"
    :aria-label="label"
    :title="label"
    @click="theme.cycle()"
  >
    <Icon :name="ICONS[theme.preference]" />
  </button>
</template>
