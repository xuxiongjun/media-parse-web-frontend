<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NInput, NSpin, NTag, useMessage } from 'naive-ui'
import axios from 'axios'
import {
  isImageResult,
  mediaDownloadUrl,
  parseShareUrl,
  platformLabel,
  type ApiErrorBody,
  type ParseResult
} from '../api/parse'

const message = useMessage()
const input = ref('')
const loading = ref(false)
const result = ref<ParseResult | null>(null)

const hasInput = computed(() => input.value.trim().length > 0)
const canSubmit = computed(() => hasInput.value && !loading.value)
const imageMode = computed(() => isImageResult(result.value))
const images = computed(() => result.value?.imageProxyUrls ?? [])

async function onParse(text?: string) {
  const url = (text ?? input.value).trim()
  if (!url || loading.value) return
  input.value = url
  loading.value = true
  result.value = null
  try {
    result.value = await parseShareUrl(url)
    message.success('解析成功')
  } catch (err) {
    let tip = '解析失败，请稍后重试'
    if (axios.isAxiosError(err)) {
      const data = err.response?.data as ApiErrorBody | undefined
      tip = data?.message || tip
    }
    message.error(tip)
  } finally {
    loading.value = false
  }
}

function onClear() {
  input.value = ''
  result.value = null
}

async function onPasteAndSearch() {
  if (loading.value) return
  try {
    if (!navigator.clipboard?.readText) {
      message.warning('当前环境不支持读取剪贴板，请手动粘贴后解析')
      return
    }
    const text = (await navigator.clipboard.readText()).trim()
    if (!text) {
      message.warning('剪贴板为空，请先复制分享链接')
      return
    }
    await onParse(text)
  } catch {
    message.error('读取剪贴板失败，请检查浏览器权限或手动粘贴')
  }
}

function onDownloadVideo() {
  if (!result.value?.videoProxyUrl) return
  window.open(mediaDownloadUrl(result.value.videoProxyUrl), '_blank')
}

function onDownloadImage(proxyUrl: string) {
  window.open(mediaDownloadUrl(proxyUrl), '_blank')
}

async function copyText(text: string, okTip: string) {
  try {
    await navigator.clipboard.writeText(text)
    message.success(okTip)
  } catch {
    message.error('复制失败，请手动选择复制')
  }
}

function onCopyTitle() {
  const title = result.value?.title?.trim()
  if (!title) {
    message.warning('没有可复制的标题')
    return
  }
  copyText(title, '标题已复制')
}

function onCopyImageLink(proxyUrl: string) {
  const absolute = new URL(proxyUrl, window.location.origin).href
  copyText(absolute, '图片链接已复制')
}

function onDownloadAllImages() {
  if (!images.value.length) return
  images.value.forEach((url, index) => {
    window.setTimeout(() => onDownloadImage(url), index * 350)
  })
  message.success(`开始下载 ${images.value.length} 张图片`)
}

function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    onParse()
  }
}
</script>

<template>
  <div class="page">
    <main class="shell">
      <header class="hero">
        <p class="brand">清影解析</p>
        <h1 class="headline">粘贴分享链接，获取可预览与下载的视频 / 图集</h1>
        <p class="sub">支持抖音、小红书。解析结果经服务端代理，不直接暴露真实资源地址。</p>
      </header>

      <section class="panel">
        <label class="label" for="share-input">分享链接</label>
        <NInput
          id="share-input"
          v-model:value="input"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 6 }"
          placeholder="粘贴抖音 / 小红书分享文案或链接…"
          :disabled="loading"
          @keydown="onKeydown"
        />
        <div class="actions">
          <NButton v-if="hasInput" quaternary :disabled="loading" @click="onClear">
            清空
          </NButton>
          <NButton
            v-else
            type="primary"
            size="large"
            :loading="loading"
            :disabled="loading"
            @click="onPasteAndSearch"
          >
            粘贴并搜索
          </NButton>
          <NButton
            v-if="hasInput"
            type="primary"
            size="large"
            :loading="loading"
            :disabled="!canSubmit"
            @click="() => onParse()"
          >
            开始解析
          </NButton>
        </div>
      </section>

      <section v-if="loading" class="loading-wrap">
        <NSpin size="large" />
        <p>正在解析，请稍候…</p>
      </section>

      <section v-else-if="result && imageMode" class="result result-images">
        <div class="result-meta">
          <div class="meta-top">
            <NTag size="small" round :bordered="false" type="success">
              {{ platformLabel(result.platform) }} · 图文
            </NTag>
            <span class="duration">共 {{ images.length }} 张</span>
          </div>
          <h2 class="title">{{ result.title || '未命名图文' }}</h2>
          <p v-if="result.author" class="author">作者：{{ result.author }}</p>
          <div class="batch-actions">
            <NButton strong secondary @click="onCopyTitle">复制标题文案</NButton>
            <NButton type="primary" @click="onDownloadAllImages">保存所有图片</NButton>
          </div>
        </div>

        <div class="image-grid">
          <article v-for="(img, index) in images" :key="img" class="image-card">
            <img :src="img" :alt="`图片 ${index + 1}`" loading="lazy" />
            <div class="image-actions">
              <button type="button" class="link-btn" @click="onCopyImageLink(img)">复制链接</button>
              <button type="button" class="link-btn" @click="onDownloadImage(img)">下载图片</button>
            </div>
          </article>
        </div>
        <p class="hint">代理链接短时有效，过期请重新解析。</p>
      </section>

      <section v-else-if="result" class="result">
        <div class="result-media">
          <video
            class="player"
            controls
            playsinline
            :poster="result.coverProxyUrl || undefined"
            :src="result.videoProxyUrl"
          />
        </div>
        <div class="result-meta">
          <div class="meta-top">
            <NTag size="small" round :bordered="false" type="success">
              {{ platformLabel(result.platform) }}
            </NTag>
            <span v-if="result.duration" class="duration">{{ result.duration }}s</span>
          </div>
          <h2 class="title">{{ result.title || '未命名视频' }}</h2>
          <p v-if="result.author" class="author">作者：{{ result.author }}</p>
          <NButton type="primary" size="large" block @click="onDownloadVideo">
            下载无水印视频
          </NButton>
          <p class="hint">代理链接短时有效，过期请重新解析。</p>
        </div>
      </section>

      <footer class="foot">
        <p>仅供学习与个人备份有权内容。请遵守平台协议与版权法规，勿用于未授权传播。</p>
      </footer>
    </main>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  padding: 28px 16px 40px;
  display: flex;
  justify-content: center;
}

.shell {
  width: min(920px, 100%);
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.hero {
  padding: 12px 4px 0;
}

.brand {
  margin: 0 0 10px;
  font-family: var(--font-display);
  font-size: clamp(2rem, 5vw, 2.8rem);
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--accent);
  line-height: 1.1;
}

.headline {
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(1.15rem, 2.6vw, 1.45rem);
  font-weight: 500;
  line-height: 1.45;
  color: var(--ink);
}

.sub {
  margin: 10px 0 0;
  color: var(--muted);
  font-size: 0.95rem;
  line-height: 1.6;
  max-width: 42rem;
}

.panel {
  background: rgba(16, 32, 28, 0.72);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 18px;
  box-shadow: var(--shadow);
  backdrop-filter: blur(10px);
}

.label {
  display: block;
  margin-bottom: 10px;
  color: var(--muted);
  font-size: 0.9rem;
}

.actions {
  margin-top: 14px;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}

.loading-wrap {
  display: grid;
  place-items: center;
  gap: 12px;
  padding: 36px 12px;
  color: var(--muted);
}

.result {
  display: grid;
  grid-template-columns: 1.35fr 1fr;
  gap: 16px;
  background: rgba(16, 32, 28, 0.72);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 16px;
  box-shadow: var(--shadow);
}

.result-images {
  grid-template-columns: 1fr;
}

.result-media {
  min-width: 0;
}

.player {
  width: 100%;
  aspect-ratio: 9 / 16;
  max-height: 520px;
  object-fit: contain;
  background: #000;
  border-radius: 14px;
}

.result-meta {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.meta-top {
  display: flex;
  align-items: center;
  gap: 10px;
}

.duration {
  color: var(--muted);
  font-size: 0.85rem;
}

.title {
  margin: 0;
  font-size: 1.15rem;
  line-height: 1.45;
  font-weight: 600;
  word-break: break-word;
}

.author {
  margin: 0;
  color: var(--muted);
  font-size: 0.92rem;
}

.batch-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.batch-actions :deep(.n-button) {
  flex: 1;
  min-width: 140px;
}

.image-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.image-card {
  min-width: 0;
}

.image-card img {
  width: 100%;
  aspect-ratio: 3 / 4;
  object-fit: cover;
  border-radius: 12px;
  background: #0a1210;
  display: block;
}

.image-actions {
  margin-top: 8px;
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.link-btn {
  border: 0;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  padding: 4px 0;
  font-size: 0.9rem;
}

.link-btn:hover {
  color: #45e0b6;
}

.hint {
  margin: 0;
  color: var(--muted);
  font-size: 0.82rem;
}

.foot {
  padding: 4px;
  color: var(--muted);
  font-size: 0.8rem;
  line-height: 1.55;
}

@media (max-width: 768px) {
  .page {
    padding: 20px 12px 32px;
  }

  .result {
    grid-template-columns: 1fr;
  }

  .player {
    max-height: 420px;
  }

  .actions {
    justify-content: stretch;
  }

  .actions :deep(.n-button) {
    flex: 1;
  }

  .image-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
}
</style>
