<script setup lang="ts">
import { TooltipProvider } from "reka-ui";
import LoginScreen from "./components/auth/LoginScreen.vue";
import WorkspaceShell from "./components/workspace/WorkspaceShell.vue";
import { useColorScheme } from "./composables/useColorScheme";
import { useSessionStore } from "./stores/session";

const session = useSessionStore();
useColorScheme();
</script>

<template>
  <TooltipProvider>
    <!-- While the session is being checked neither screen is shown: only the themed page. -->
    <LoginScreen v-if="session.status === 'signed-out'" />
    <WorkspaceShell v-else-if="session.status === 'signed-in'" />
  </TooltipProvider>
</template>
