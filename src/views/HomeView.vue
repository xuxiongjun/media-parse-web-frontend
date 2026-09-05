<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NInput, NSpin, NTag, useMessage } from 'naive-ui'
import axios from 'axios'
import {
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

const canSubmit = computed(() => input.value.trim().length > 0 && !loading.value)

async function onParse() {
  if (!canSubmit.value) return
  loading.value = true
  result.value = null
  try {
    result.value = await parseShareUrl(input.value.trim())
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

function onDownload() {
  if (!result.value?.videoProxyUrl) return
  window.open(mediaDownloadUrl(result.value.videoProxyUrl), '_blank')
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
        <h1 class="headline">粘贴分享链接，获取可预览与下载的视频</h1>
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
          <NButton quaternary @click="onClear" :disabled="loading || (!input && !result)">
            清空
          </NButton>
          <NButton type="primary" size="large" :loading="loading" :disabled="!canSubmit" @click="onParse">
            开始解析
          </NButton>
        </div>
      </section>

      <section v-if="loading" class="loading-wrap">
        <NSpin size="large" />
        <p>正在解析，请稍候…</p>
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
          <NButton type="primary" size="large" block @click="onDownload">
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
}
</style>
