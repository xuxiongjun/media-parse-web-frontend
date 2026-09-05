<script setup lang="ts">
import { NConfigProvider, NMessageProvider, darkTheme, type GlobalThemeOverrides } from 'naive-ui'
import HomeView from './views/HomeView.vue'

const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#2dd4a8',
    primaryColorHover: '#45e0b6',
    primaryColorPressed: '#1aa884',
    primaryColorSuppl: '#2dd4a8',
    borderRadius: '12px',
    fontFamily: 'Noto Sans SC, Outfit, sans-serif'
  },
  Button: {
    fontWeightStrong: '600'
  },
  Input: {
    color: 'rgba(16, 32, 28, 0.85)',
    colorFocus: 'rgba(16, 32, 28, 0.95)',
    border: '1px solid rgba(232, 242, 238, 0.14)',
    borderHover: '1px solid rgba(45, 212, 168, 0.45)',
    borderFocus: '1px solid rgba(45, 212, 168, 0.75)',
    placeholderColor: '#7f9a90',
    textColor: '#e8f2ee',
    caretColor: '#2dd4a8'
  },
  Progress: {
    fillColor: '#2dd4a8',
    railColor: 'rgba(232, 242, 238, 0.12)',
    textColorInside: '#0b1412'
  },
  Collapse: {
    titleTextColor: '#e8f2ee',
    arrowColor: '#9bb5ab',
    dividerColor: 'transparent'
  }
}
</script>

<template>
  <NConfigProvider :theme="darkTheme" :theme-overrides="themeOverrides">
    <NMessageProvider>
      <HomeView />
    </NMessageProvider>
  </NConfigProvider>
</template>
