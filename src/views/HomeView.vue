<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  NButton,
  NCollapse,
  NCollapseItem,
  NInput,
  NProgress,
  NTag,
  useMessage
} from 'naive-ui'
import axios from 'axios'
import {
  collectShareEntries,
  extractFirstUrl,
  isImageResult,
  mediaDownloadUrl,
  parseShareUrl,
  platformLabel,
  type ApiErrorBody,
  type ParseResult
} from '../api/parse'

type ItemStatus = 'idle' | 'parsing' | 'done' | 'error'

interface QueueItem {
  id: string
  raw: string
  status: ItemStatus
  result: ParseResult | null
  error: string | null
}

const message = useMessage()
const draft = ref('')
const queue = ref<QueueItem[]>([])
const loading = ref(false)
const progressDone = ref(0)
const progressTotal = ref(0)
const expandedNames = ref<string[]>([])

let idSeq = 0
function nextId() {
  idSeq += 1
  return `item-${idSeq}`
}

const hasDraft = computed(() => draft.value.trim().length > 0)
const hasQueue = computed(() => queue.value.length > 0)
const progressPercent = computed(() => {
  if (!progressTotal.value) return 0
  return Math.round((progressDone.value / progressTotal.value) * 100)
})
const successCount = computed(() => queue.value.filter((i) => i.status === 'done').length)
const failCount = computed(() => queue.value.filter((i) => i.status === 'error').length)
const doneItems = computed(() => queue.value.filter((i) => i.status === 'done' || i.status === 'error'))

watch(
  doneItems,
  (items) => {
    expandedNames.value = items.map((i) => i.id)
  },
  { deep: true }
)

function makeItem(raw: string): QueueItem {
  return {
    id: nextId(),
    raw,
    status: 'idle',
    result: null,
    error: null
  }
}

function syncQueueFromDraft() {
  const entries = collectShareEntries(draft.value)
  if (!entries.length) {
    message.warning('未识别到有效链接，请检查粘贴内容')
    return
  }
  queue.value = entries.map(makeItem)
  message.success(`已整理 ${entries.length} 条链接`)
}

function addEmptyRow() {
  queue.value.push(makeItem(''))
}

function removeRow(id: string) {
  queue.value = queue.value.filter((i) => i.id !== id)
}

function onClear() {
  draft.value = ''
  queue.value = []
  progressDone.value = 0
  progressTotal.value = 0
  expandedNames.value = []
}

function shortUrl(raw: string): string {
  const url = extractFirstUrl(raw)
  if (!url) return raw.trim() || '（空）'
  try {
    const u = new URL(url)
    const path = u.pathname.length > 24 ? `${u.pathname.slice(0, 22)}…` : u.pathname
    return `${u.host}${path}`
  } catch {
    return url.length > 48 ? `${url.slice(0, 46)}…` : url
  }
}

function panelTitle(item: QueueItem, index: number): string {
  const prefix = `#${index + 1}`
  if (item.status === 'error') return `${prefix} · 失败`
  if (item.result) {
    const kind = isImageResult(item.result) ? '图文' : '视频'
    const title = item.result.title?.trim() || `未命名${kind}`
    return `${prefix} · ${kind} · ${title}`
  }
  return `${prefix} · ${shortUrl(item.raw)}`
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function errMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as ApiErrorBody | undefined
    return data?.message || '解析失败，请稍后重试'
  }
  return '解析失败，请稍后重试'
}

async function parseOne(item: QueueItem) {
  const raw = item.raw.trim()
  if (!raw || !extractFirstUrl(raw)) {
    item.status = 'error'
    item.error = '无效链接'
    item.result = null
    return
  }
  item.status = 'parsing'
  item.error = null
  try {
    item.result = await parseShareUrl(raw)
    item.status = 'done'
  } catch (err) {
    item.result = null
    item.status = 'error'
    item.error = errMessage(err)
  }
}

async function onBatchParse() {
  if (loading.value) return

  if (!queue.value.length) {
    const entries = collectShareEntries(draft.value)
    if (!entries.length) {
      message.warning('请先粘贴链接，或整理到下方列表')
      return
    }
    queue.value = entries.map(makeItem)
  }

  const targets = queue.value.filter((i) => i.raw.trim())
  if (!targets.length) {
    message.warning('列表中没有有效内容')
    return
  }

  loading.value = true
  progressDone.value = 0
  progressTotal.value = targets.length
  for (const item of targets) {
    item.status = 'idle'
    item.result = null
    item.error = null
  }

  try {
    for (let i = 0; i < targets.length; i++) {
      await parseOne(targets[i])
      progressDone.value = i + 1
      if (i < targets.length - 1) await sleep(280)
    }
    await nextTick()
    const ok = successCount.value
    const bad = failCount.value
    if (ok && !bad) message.success(`全部解析成功（${ok}）`)
    else if (ok && bad) message.warning(`完成：成功 ${ok}，失败 ${bad}`)
    else message.error(`全部失败（${bad}）`)
  } finally {
    loading.value = false
  }
}

async function onPasteAndFill() {
  if (loading.value) return
  try {
    if (!navigator.clipboard?.readText) {
      message.warning('当前环境不支持读取剪贴板，请手动粘贴')
      return
    }
    const text = (await navigator.clipboard.readText()).trim()
    if (!text) {
      message.warning('剪贴板为空')
      return
    }
    draft.value = draft.value.trim() ? `${draft.value.trim()}\n${text}` : text
    syncQueueFromDraft()
  } catch {
    message.error('读取剪贴板失败，请检查浏览器权限或手动粘贴')
  }
}

function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    onBatchParse()
  }
}

function expandAll() {
  expandedNames.value = doneItems.value.map((i) => i.id)
}

function collapseAll() {
  expandedNames.value = []
}

function onDownloadVideo(result: ParseResult) {
  if (!result.videoProxyUrl) return
  window.open(mediaDownloadUrl(result.videoProxyUrl), '_blank')
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

function onCopyTitle(result: ParseResult) {
  const title = result.title?.trim()
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

function onDownloadAllImages(result: ParseResult) {
  const images = result.imageProxyUrls ?? []
  if (!images.length) return
  images.forEach((url, index) => {
    window.setTimeout(() => onDownloadImage(url), index * 350)
  })
  message.success(`开始下载 ${images.length} 张图片`)
}

function retryOne(item: QueueItem) {
  if (loading.value) return
  loading.value = true
  progressTotal.value = 1
  progressDone.value = 0
  parseOne(item)
    .then(() => {
      progressDone.value = 1
      if (item.status === 'done') message.success('重新解析成功')
      else message.error(item.error || '重新解析失败')
    })
    .finally(() => {
      loading.value = false
    })
}
</script>

<template>
  <div class="page">
    <main class="shell">
      <header class="hero">
        <p class="brand">清影解析</p>
        <h1 class="headline">粘贴分享链接，批量获取可预览与下载的视频 / 图集</h1>
        <p class="sub">
          支持抖音、小红书。一次可粘贴多条分享文案，整理后批量解析；结果默认全部展开，便于对照下载。
        </p>
      </header>

      <section class="panel">
        <div class="panel-head">
          <label class="label" for="share-input">批量粘贴</label>
          <span class="hint-inline">每行一条分享文案或链接 · Ctrl/⌘ + Enter 开始</span>
        </div>
        <NInput
          id="share-input"
          v-model:value="draft"
          type="textarea"
          :autosize="{ minRows: 4, maxRows: 10 }"
          placeholder="可一次粘贴多条，例如：&#10;3.82 复制打开抖音… https://v.douyin.com/xxx/&#10;https://www.xiaohongshu.com/discovery/item/…"
          :disabled="loading"
          @keydown="onKeydown"
        />
        <div class="actions">
          <NButton quaternary :disabled="loading || (!hasDraft && !hasQueue)" @click="onClear">
            清空
          </NButton>
          <NButton secondary :disabled="loading || !hasDraft" @click="syncQueueFromDraft">
            整理到列表
          </NButton>
          <NButton secondary :disabled="loading" @click="onPasteAndFill">从剪贴板追加</NButton>
          <NButton
            type="primary"
            size="large"
            :loading="loading"
            :disabled="loading || (!hasQueue && !hasDraft)"
            @click="onBatchParse"
          >
            {{ hasQueue && queue.length > 1 ? `批量解析（${queue.length}）` : '开始解析' }}
          </NButton>
        </div>
      </section>

      <section v-if="hasQueue" class="panel queue-panel">
        <div class="panel-head">
          <p class="label">待解析列表</p>
          <NButton size="tiny" quaternary :disabled="loading" @click="addEmptyRow">添加一行</NButton>
        </div>
        <div class="queue-table" role="table">
          <div class="queue-row queue-head" role="row">
            <span class="col-idx">#</span>
            <span class="col-raw">分享文案 / 链接</span>
            <span class="col-status">状态</span>
            <span class="col-act">操作</span>
          </div>
          <div v-for="(item, index) in queue" :key="item.id" class="queue-row" role="row">
            <span class="col-idx">{{ index + 1 }}</span>
            <div class="col-raw">
              <NInput
                v-model:value="item.raw"
                type="textarea"
                :autosize="{ minRows: 1, maxRows: 3 }"
                placeholder="粘贴单条分享文案或链接"
                :disabled="loading"
                size="small"
              />
            </div>
            <span class="col-status">
              <NTag v-if="item.status === 'idle'" size="small" :bordered="false">待解析</NTag>
              <NTag v-else-if="item.status === 'parsing'" size="small" type="info" :bordered="false">
                解析中
              </NTag>
              <NTag v-else-if="item.status === 'done'" size="small" type="success" :bordered="false">
                成功
              </NTag>
              <NTag v-else size="small" type="error" :bordered="false">失败</NTag>
            </span>
            <span class="col-act">
              <button
                type="button"
                class="link-btn"
                :disabled="loading || queue.length <= 1"
                @click="removeRow(item.id)"
              >
                删除
              </button>
            </span>
          </div>
        </div>
      </section>

      <section v-if="loading || progressTotal > 0" class="panel progress-panel">
        <div class="progress-meta">
          <span>{{ loading ? '正在批量解析…' : '本轮解析进度' }}</span>
          <span>{{ progressDone }} / {{ progressTotal }}</span>
        </div>
        <NProgress
          type="line"
          :percentage="progressPercent"
          :processing="loading"
          :indicator-placement="'inside'"
          :height="18"
          :border-radius="9"
          :fill-border-radius="9"
        />
      </section>

      <section v-if="doneItems.length" class="results-wrap">
        <div class="results-toolbar">
          <p class="results-title">
            解析结果
            <span class="results-count">成功 {{ successCount }} · 失败 {{ failCount }}</span>
          </p>
          <div class="toolbar-actions">
            <NButton size="small" quaternary @click="expandAll">全部展开</NButton>
            <NButton size="small" quaternary @click="collapseAll">全部折叠</NButton>
          </div>
        </div>

        <NCollapse v-model:expanded-names="expandedNames" display-directive="show">
          <NCollapseItem
            v-for="(item, index) in doneItems"
            :key="item.id"
            :name="item.id"
            :title="panelTitle(item, index)"
          >
            <div v-if="item.status === 'error'" class="error-body">
              <p>{{ item.error || '解析失败' }}</p>
              <p class="error-url">{{ shortUrl(item.raw) }}</p>
              <NButton size="small" secondary :disabled="loading" @click="retryOne(item)">
                重试此条
              </NButton>
            </div>

            <template v-else-if="item.result && isImageResult(item.result)">
              <div class="result result-images">
                <div class="result-meta">
                  <div class="meta-top">
                    <NTag size="small" round :bordered="false" type="success">
                      {{ platformLabel(item.result.platform) }} · 图文
                    </NTag>
                    <span class="duration">共 {{ item.result.imageProxyUrls?.length || 0 }} 张</span>
                  </div>
                  <h2 class="title">{{ item.result.title || '未命名图文' }}</h2>
                  <p v-if="item.result.author" class="author">作者：{{ item.result.author }}</p>
                  <div class="batch-actions">
                    <NButton strong secondary @click="onCopyTitle(item.result)">复制标题文案</NButton>
                    <NButton type="primary" @click="onDownloadAllImages(item.result)">
                      保存所有图片
                    </NButton>
                  </div>
                </div>
                <div class="image-grid">
                  <article
                    v-for="(img, imgIndex) in item.result.imageProxyUrls || []"
                    :key="img"
                    class="image-card"
                  >
                    <img :src="img" :alt="`图片 ${imgIndex + 1}`" loading="lazy" />
                    <div class="image-actions">
                      <button type="button" class="link-btn" @click="onCopyImageLink(img)">
                        复制链接
                      </button>
                      <button type="button" class="link-btn" @click="onDownloadImage(img)">
                        下载图片
                      </button>
                    </div>
                  </article>
                </div>
                <p class="hint">代理链接短时有效，过期请重新解析。</p>
              </div>
            </template>

            <template v-else-if="item.result">
              <div class="result">
                <div class="result-media">
                  <video
                    class="player"
                    controls
                    playsinline
                    :poster="item.result.coverProxyUrl || undefined"
                    :src="item.result.videoProxyUrl"
                  />
                </div>
                <div class="result-meta">
                  <div class="meta-top">
                    <NTag size="small" round :bordered="false" type="success">
                      {{ platformLabel(item.result.platform) }}
                    </NTag>
                    <span v-if="item.result.duration" class="duration">{{ item.result.duration }}s</span>
                  </div>
                  <h2 class="title">{{ item.result.title || '未命名视频' }}</h2>
                  <p v-if="item.result.author" class="author">作者：{{ item.result.author }}</p>
                  <NButton type="primary" size="large" block @click="onDownloadVideo(item.result)">
                    下载无水印视频
                  </NButton>
                  <p class="hint">代理链接短时有效，过期请重新解析。</p>
                </div>
              </div>
            </template>
          </NCollapseItem>
        </NCollapse>
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

.panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.label {
  margin: 0;
  color: var(--muted);
  font-size: 0.9rem;
}

.hint-inline {
  color: var(--muted);
  font-size: 0.8rem;
  opacity: 0.9;
}

.actions {
  margin-top: 14px;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}

.queue-table {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.queue-row {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 72px 52px;
  gap: 10px;
  align-items: start;
}

.queue-head {
  color: var(--muted);
  font-size: 0.8rem;
  padding: 0 2px 4px;
  border-bottom: 1px solid var(--line);
}

.col-idx,
.col-status,
.col-act {
  padding-top: 6px;
  color: var(--muted);
  font-size: 0.85rem;
}

.col-act {
  text-align: right;
}

.progress-panel {
  padding-block: 14px;
}

.progress-meta {
  display: flex;
  justify-content: space-between;
  margin-bottom: 10px;
  color: var(--muted);
  font-size: 0.88rem;
}

.results-wrap {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.results-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 0 4px;
}

.results-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}

.results-count {
  color: var(--muted);
  font-size: 0.85rem;
  font-weight: 400;
}

.toolbar-actions {
  display: flex;
  gap: 4px;
}

.results-wrap :deep(.n-collapse) {
  background: transparent;
  border: 0;
}

.results-wrap :deep(.n-collapse-item) {
  background: rgba(16, 32, 28, 0.72);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  margin-bottom: 12px;
  overflow: hidden;
}

.results-wrap :deep(.n-collapse-item__header) {
  padding: 14px 16px;
  font-weight: 600;
  color: var(--ink);
}

.results-wrap :deep(.n-collapse-item__content-inner) {
  padding: 0 16px 16px;
}

.error-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  color: var(--danger);
}

.error-body p {
  margin: 0;
}

.error-url {
  color: var(--muted) !important;
  font-size: 0.85rem;
  word-break: break-all;
}

.result {
  display: grid;
  grid-template-columns: 1.35fr 1fr;
  gap: 16px;
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

.link-btn:hover:not(:disabled) {
  color: #45e0b6;
}

.link-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
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

  .queue-row {
    grid-template-columns: 28px minmax(0, 1fr);
    grid-template-areas:
      'idx raw'
      'status act';
  }

  .col-idx {
    grid-area: idx;
  }

  .col-raw {
    grid-area: raw;
  }

  .col-status {
    grid-area: status;
  }

  .col-act {
    grid-area: act;
  }

  .queue-head {
    display: none;
  }

  .image-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
}
</style>
