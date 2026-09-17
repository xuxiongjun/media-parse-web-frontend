import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'
import RemoveWatermarkView from '../views/RemoveWatermarkView.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'parse', component: HomeView },
    { path: '/remove-watermark', name: 'remove-watermark', component: RemoveWatermarkView }
  ],
  scrollBehavior() {
    return { top: 0 }
  }
})

export default router
