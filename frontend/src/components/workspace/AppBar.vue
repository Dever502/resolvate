<script setup lang="ts">
import { ref, watch } from "vue";
import { useNarrowScreen } from "../../composables/useNarrowScreen";
import { useProjectsStore } from "../../stores/projects";
import ReplyCatalog from "../composer/ReplyCatalog.vue";
import ProjectPicker from "../projects/ProjectPicker.vue";
import Icon from "../ui/Icon.vue";
import AdminMenu from "./AdminMenu.vue";
import MobileMenu from "./MobileMenu.vue";

// Project choice on the left, the product mark in the centre (equal outer tracks keep it centred),
// administration and the quick replies catalog on the right. Narrow screens get one compact row
// instead, the same over the list and in a dialogue: the menu button with the current project, whose
// drawer (MobileMenu.vue) holds the project choice, administration, the catalog and the account.
const projects = useProjectsStore();
const narrow = useNarrowScreen();
const catalogOpen = ref(false);
watch(() => projects.currentId, () => { catalogOpen.value = false; });
</script>

<template>
  <header
    class="chrome grid min-h-[76px] shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-6 px-6 py-3.5 compact:gap-4 compact:px-4 narrow:flex narrow:min-h-14 narrow:gap-2 narrow:px-2 narrow:pt-[max(.375rem,env(safe-area-inset-top))] narrow:pb-1.5"
    aria-label="Проект и управление"
  >
    <MobileMenu v-if="narrow" class="flex" @catalog="catalogOpen = true" />
    <template v-else>
      <ProjectPicker class="col-start-1 row-start-1 max-w-[calc(var(--sidebar-width)-3rem)]" />
      <div class="brand col-start-2 row-start-1 min-w-0 justify-self-center whitespace-nowrap text-xl">
        <span class="brand-mark bg-white text-selection" aria-hidden="true"><Icon name="resolve" /></span>
        Resolvate
      </div>
      <!-- Both buttons are 44 px tall hit areas; their negative margins keep the bar's height. -->
      <div class="col-start-3 row-start-1 flex min-w-0 items-center justify-self-end gap-1">
        <AdminMenu />
        <button type="button" class="quiet -my-1 min-h-11 text-sm" aria-label="Управление готовыми ответами"
          :disabled="!projects.currentId" @click="catalogOpen = true">Готовые ответы</button>
      </div>
    </template>
    <ReplyCatalog v-if="projects.currentId" :key="projects.currentId" v-model:open="catalogOpen" :project-id="projects.currentId" />
  </header>
</template>
