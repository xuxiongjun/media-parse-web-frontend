import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'parse',
      component: () => import('../views/HomeView.vue')
    },
    {
      path: '/remove-watermark',
      name: 'remove-watermark',
      component: () => import('../views/RemoveWatermarkView.vue')
    }
  ],
  scrollBehavior() {
    return { top: 0 }
  }
})

export default router
