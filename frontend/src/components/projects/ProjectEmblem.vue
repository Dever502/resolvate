<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { Project } from "../../api/types";
import { initials } from "../../lib/initials";
import { logoUrl } from "../../stores/projects";

// A project's emblem: its logo over its initial, which shows while the logo loads or if it fails.
const props = defineProps<{ project: Project | null }>();
const logo = computed(() => (props.project?.logo ? logoUrl(props.project) : ""));
const failed = ref(false);
watch(logo, () => {
  failed.value = false;
});
</script>

<template>
  <div class="project-emblem" aria-hidden="true">
    <span>{{ initials(project?.name || "R") }}</span>
    <img v-if="logo && !failed" :src="logo" alt="" class="project-logo" @error="failed = true" />
  </div>
</template>
