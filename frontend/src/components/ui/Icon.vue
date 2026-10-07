<script setup lang="ts">
import { iconPaths, type IconName } from "./icons";

defineProps<{ name: IconName }>();
</script>

<template>
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path :d="iconPaths[name]" />
  </svg>
</template>
