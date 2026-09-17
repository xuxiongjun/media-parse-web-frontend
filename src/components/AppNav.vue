<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()

const active = computed(() => route.name)

function go(name: 'parse' | 'remove-watermark') {
  if (route.name !== name) router.push({ name })
}
</script>

<template>
  <nav class="app-nav" aria-label="主导航">
    <button type="button" class="brand-btn" @click="go('parse')">清影解析</button>
    <div class="links">
      <button type="button" class="nav-link" :class="{ active: active === 'parse' }" @click="go('parse')">
        链接解析
      </button>
      <button
        type="button"
        class="nav-link"
        :class="{ active: active === 'remove-watermark' }"
        @click="go('remove-watermark')"
      >
        媒体去水印
      </button>
    </div>
  </nav>
</template>

<style scoped>
.app-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 4px 0;
  flex-wrap: wrap;
}

.brand-btn {
  border: none;
  background: transparent;
  color: var(--accent);
  font-family: var(--font-display);
  font-size: clamp(1.35rem, 3vw, 1.75rem);
  font-weight: 700;
  letter-spacing: 0.02em;
  cursor: pointer;
  padding: 0;
}

.links {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.nav-link {
  border: 1px solid var(--line);
  background: rgba(16, 32, 28, 0.55);
  color: var(--muted);
  border-radius: 999px;
  padding: 8px 14px;
  font-size: 0.88rem;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}

.nav-link:hover {
  color: var(--ink);
  border-color: rgba(45, 212, 168, 0.35);
}

.nav-link.active {
  color: var(--ink);
  border-color: rgba(45, 212, 168, 0.65);
  background: rgba(45, 212, 168, 0.12);
}
</style>
