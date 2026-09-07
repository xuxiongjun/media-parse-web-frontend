<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  NButton,
  NCollapse,
  NCollapseItem,
  NInput,
  NProgress,
  NTag,
  useDialog,
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
  triggerBrowserDownload,
  type ApiErrorBody,
  type ParseResult
} from '../api/parse'
import {
  canUseDirectoryPicker,
  isExpiredDownloadReason,
  pickDownloadFolder,
  writeOneUrlToDirectory
} from '../api/folderDownload'

type ItemStatus = 'idle' | 'parsing' | 'done' | 'error'

interface QueueItem {
  id: string
  raw: string
  status: ItemStatus
  result: ParseResult | null
  error: string | null
}

/** 批量下载失败，供用户再次触发保存 */
interface DownloadFailItem {
  url: string
  label: string
  reason: string
  /** 对应队列中的分享文案 / 链接，便于复制 */
  raw?: string
  itemId?: string
  kind?: 'video' | 'image'
  imageIndex?: number
}

interface DownloadJob {
  url: string
  label: string
  raw?: string
  itemId?: string
  kind?: 'video' | 'image'
  imageIndex?: number
}

/**
   * 代理 token TTL 为 1 小时（app.media-token-ttl-seconds=3600）。
   * 仅在剩余不足该余量时提前刷新；勿设成整段 TTL，否则解析后几乎立刻被判定为即将过期。
   */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000

const message = useMessage()
const dialog = useDialog()
const draft = ref('')
const queue = ref<QueueItem[]>([])
const loading = ref(false)
const downloadingAll = ref(false)
const downloadSaveDone = ref(0)
const downloadSaveTotal = ref(0)
const downloadSaveLabel = ref('')
const downloadSaveFailHint = ref('')
const downloadFailList = ref<DownloadFailItem[]>([])
const progressDone = ref(0)
const progressTotal = ref(0)
const progressPanelRef = ref<HTMLElement | null>(null)
const progressPanelInView = ref(true)
const expandedNames = ref<string[]>([])
const showBackTop = ref(false)

let progressObserver: IntersectionObserver | null = null

/** 单次批量上限，避免过长列表拖垮页面与接口 */
const MAX_QUEUE = 99
/** 超过该数量不再自动展开结果，避免同时挂载大量媒体导致卡死 */
const AUTO_EXPAND_LIMIT = 8

let idSeq = 0
function nextId() {
  idSeq += 1
  return `item-${idSeq}`
}

function jobsFromQueueItem(item: QueueItem, index: number): DownloadJob[] {
  if (item.status !== 'done' || !item.result) return []
  const jobs: DownloadJob[] = []
  const num = index + 1
  const title = item.result.title?.trim() || shortUrl(item.raw)
  const raw = item.raw.trim()
  if (isImageResult(item.result)) {
    const images = item.result.imageProxyUrls ?? []
    images.forEach((url, imgIndex) => {
      jobs.push({
        url,
        label: `#${num} · 图${imgIndex + 1}/${images.length} · ${title}`,
        raw,
        itemId: item.id,
        kind: 'image',
        imageIndex: imgIndex
      })
    })
  } else if (item.result.videoProxyUrl) {
    jobs.push({
      url: item.result.videoProxyUrl,
      label: `#${num} · 视频 · ${title}`,
      raw,
      itemId: item.id,
      kind: 'video'
    })
  }
  return jobs
}

function collectDownloadJobs(): DownloadJob[] {
  const jobs: DownloadJob[] = []
  queue.value.forEach((item, index) => {
    jobs.push(...jobsFromQueueItem(item, index))
  })
  return jobs
}

function isTokenStale(result: ParseResult | null | undefined): boolean {
  if (!result?.expireAt) return false
  return result.expireAt - Date.now() < TOKEN_REFRESH_MARGIN_MS
}

function resolveJobAfterRefresh(item: QueueItem, job: DownloadJob): DownloadJob | null {
  const index = queue.value.findIndex((q) => q.id === item.id)
  const freshJobs = jobsFromQueueItem(item, index >= 0 ? index : 0)
  if (job.kind === 'video') {
    return freshJobs.find((j) => j.kind === 'video') || null
  }
  if (job.kind === 'image' && job.imageIndex != null) {
    return (
      freshJobs.find((j) => j.kind === 'image' && j.imageIndex === job.imageIndex) || null
    )
  }
  return freshJobs[0] || null
}

function collectDownloadUrls(): string[] {
  return collectDownloadJobs().map((j) => j.url)
}

const hasDraft = computed(() => draft.value.trim().length > 0)
const hasQueue = computed(() => queue.value.length > 0)
const queueAtLimit = computed(() => queue.value.length >= MAX_QUEUE)
const progressPercent = computed(() => {
  if (!progressTotal.value) return 0
  return Math.round((progressDone.value / progressTotal.value) * 100)
})
const showFloatingParseProgress = computed(
  () => loading.value && progressTotal.value > 0 && !progressPanelInView.value
)
const successCount = computed(() => queue.value.filter((i) => i.status === 'done').length)
const failCount = computed(() => queue.value.filter((i) => i.status === 'error').length)
const doneItems = computed(() => queue.value.filter((i) => i.status === 'done' || i.status === 'error'))
const downloadableCount = computed(() => collectDownloadUrls().length)
const downloadFailCount = computed(() => downloadFailList.value.length)
const highlightId = ref<string | null>(null)
let highlightTimer: number | undefined

/** 超过上限时截取前 MAX_QUEUE 条，并提示未写入数量 */
function takeEntriesWithCap(entries: string[]): string[] {
  if (entries.length <= MAX_QUEUE) return entries
  const dropped = entries.length - MAX_QUEUE
  message.warning(
    `一次最多 ${MAX_QUEUE} 条，已写入前 ${MAX_QUEUE} 条，超出 ${dropped} 条未添加`
  )
  return entries.slice(0, MAX_QUEUE)
}

function onWindowScroll() {
  showBackTop.value = window.scrollY > 360
}

function scrollToTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function scrollToProgress() {
  progressPanelRef.value?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function bindProgressObserver(el: HTMLElement | null) {
  progressObserver?.disconnect()
  progressObserver = null
  if (!el) {
    progressPanelInView.value = true
    return
  }
  progressObserver = new IntersectionObserver(
    ([entry]) => {
      progressPanelInView.value = entry.isIntersecting
    },
    { threshold: 0.15, rootMargin: '0px' }
  )
  progressObserver.observe(el)
}

watch(progressPanelRef, (el) => {
  bindProgressObserver(el)
})

onMounted(() => {
  window.addEventListener('scroll', onWindowScroll, { passive: true })
  onWindowScroll()
})

onUnmounted(() => {
  window.removeEventListener('scroll', onWindowScroll)
  progressObserver?.disconnect()
  progressObserver = null
  if (highlightTimer !== undefined) window.clearTimeout(highlightTimer)
})

/** 仅自动展开新完成的条目（小批量）；保留用户手动折叠状态 */
watch(
  () => doneItems.value.map((i) => i.id),
  (ids, prevIds = []) => {
    const prev = new Set(prevIds)
    const newlyDone = ids.filter((id) => !prev.has(id))
    if (newlyDone.length && ids.length <= AUTO_EXPAND_LIMIT) {
      const open = new Set(expandedNames.value)
      for (const id of newlyDone) open.add(id)
      expandedNames.value = [...open]
    }
    const keep = new Set(ids)
    expandedNames.value = expandedNames.value.filter((id) => keep.has(id))
  }
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
  const collected = collectShareEntries(draft.value)
  if (!collected.length) {
    message.warning('未识别到有效链接，请检查粘贴内容')
    return
  }
  const entries = takeEntriesWithCap(collected)
  queue.value = entries.map(makeItem)
  if (collected.length <= MAX_QUEUE) {
    message.success(`已整理 ${entries.length} 条链接`)
  }
}

function addEmptyRow() {
  if (queue.value.length >= MAX_QUEUE) {
    message.warning(`列表最多 ${MAX_QUEUE} 条`)
    return
  }
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
  highlightId.value = null
  downloadFailList.value = []
  if (highlightTimer !== undefined) window.clearTimeout(highlightTimer)
}

function flashHighlight(id: string) {
  highlightId.value = id
  if (highlightTimer !== undefined) window.clearTimeout(highlightTimer)
  highlightTimer = window.setTimeout(() => {
    if (highlightId.value === id) highlightId.value = null
  }, 1600)
}

async function locateResult(item: QueueItem) {
  if (item.status !== 'done' && item.status !== 'error') {
    message.warning('该条尚未出现在解析结果中')
    return
  }
  if (!expandedNames.value.includes(item.id)) {
    expandedNames.value = [...expandedNames.value, item.id]
  }
  await nextTick()
  await nextTick()
  const anchor = document.getElementById(`result-${item.id}`)
  const el = (anchor?.closest('.n-collapse-item') as HTMLElement | null) ?? anchor
  if (!el) {
    message.warning('未找到对应结果，请稍后再试')
    return
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  flashHighlight(item.id)
}

async function locateQueueRow(item: QueueItem) {
  await nextTick()
  const el = document.getElementById(`queue-${item.id}`)
  if (!el) {
    message.warning('未找到对应表格行')
    return
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  flashHighlight(item.id)
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

/**
 * 批量解析：有限并发 + 启动间隔。
 * 并发可显著缩短总耗时；间隔用于避免瞬间打满本后端 IP 限流（默认 120/分钟）。
 */
const BATCH_CONCURRENCY = 3
const BATCH_GAP_MS = 280
/** 批量下载并发（选文件夹写入 / 浏览器触发下载） */
const DOWNLOAD_CONCURRENCY = 3
/** 浏览器多文件下载触发间隔，降低「多个下载」拦截概率 */
const DOWNLOAD_GAP_MS = 180
const RATE_LIMIT_BACKOFF_MS = 3500
const RATE_LIMIT_MAX_RETRY = 2

function isRateLimited(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false
  if (err.response?.status === 429) return true
  const data = err.response?.data as ApiErrorBody | undefined
  return data?.code === 'RATE_LIMIT'
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
  let attempt = 0
  while (true) {
    try {
      item.result = await parseShareUrl(raw)
      item.status = 'done'
      return
    } catch (err) {
      if (isRateLimited(err) && attempt < RATE_LIMIT_MAX_RETRY) {
        attempt += 1
        await sleep(RATE_LIMIT_BACKOFF_MS * attempt)
        continue
      }
      item.result = null
      item.status = 'error'
      item.error = errMessage(err)
      return
    }
  }
}

/** 有限并发跑队列：同时最多 BATCH_CONCURRENCY 条，取下一项前稍作间隔 */
async function runParsePool(targets: QueueItem[]) {
  let cursor = 0
  let finished = 0

  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= targets.length) return
      await parseOne(targets[i])
      finished += 1
      progressDone.value = finished
      if (cursor < targets.length) await sleep(BATCH_GAP_MS)
    }
  }

  const workers = Math.min(BATCH_CONCURRENCY, targets.length)
  await Promise.all(Array.from({ length: workers }, () => worker()))
}

async function onBatchParse() {
  if (loading.value) return

  // 粘贴区有可识别链接时，始终覆盖待解析列表（避免二次粘贴仍用旧队列）
  const collected = collectShareEntries(draft.value)
  if (collected.length) {
    queue.value = takeEntriesWithCap(collected).map(makeItem)
  } else if (!queue.value.length) {
    message.warning('请先粘贴链接，或整理到下方列表')
    return
  } else if (queue.value.length > MAX_QUEUE) {
    const dropped = queue.value.length - MAX_QUEUE
    queue.value = queue.value.slice(0, MAX_QUEUE)
    message.warning(`列表最多 ${MAX_QUEUE} 条，已截取前 ${MAX_QUEUE} 条，超出 ${dropped} 条未保留`)
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
    await runParsePool(targets)
    await nextTick()
    const ok = successCount.value
    const bad = failCount.value
    if (ok && !bad) {
      dialog?.info({
        title: '解析完成',
        content: '链接已经全部解析完成，是否下载全部',
        positiveText: '下载全部',
        negativeText: '暂不',
        onPositiveClick: () => {
          void onDownloadAll()
        }
      })
    } else if (ok && bad) {
      dialog?.info({
        title: '解析完成',
        content: `完成：成功 ${ok}，失败 ${bad}。是否下载已成功解析的内容？`,
        positiveText: '下载全部',
        negativeText: '暂不',
        onPositiveClick: () => {
          void onDownloadAll()
        }
      })
    } else {
      message.error(`全部失败（${bad}）`)
    }
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
  const items = doneItems.value
  if (items.length > AUTO_EXPAND_LIMIT) {
    expandedNames.value = items.slice(0, AUTO_EXPAND_LIMIT).map((i) => i.id)
    message.warning(
      `结果较多，全部展开易卡顿，已展开前 ${AUTO_EXPAND_LIMIT} 条（共 ${items.length}）`
    )
    return
  }
  expandedNames.value = items.map((i) => i.id)
}

function collapseAll() {
  expandedNames.value = []
}

function downloadProxy(proxyUrl: string, filename?: string) {
  triggerBrowserDownload(mediaDownloadUrl(proxyUrl), filename)
}

function onDownloadVideo(result: ParseResult) {
  if (!result.videoProxyUrl) return
  downloadProxy(result.videoProxyUrl)
  message.success('已开始下载视频')
}

function onDownloadImage(proxyUrl: string) {
  downloadProxy(proxyUrl)
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

function copyFailedTexts() {
  const texts = queue.value
    .filter((i) => i.status === 'error')
    .map((i) => i.raw.trim())
    .filter(Boolean)
  if (!texts.length) {
    message.warning('没有可复制的失败文案')
    return
  }
  copyText(texts.join('\n'), `已复制 ${texts.length} 条失败文案`)
}

function copyDownloadFailedTexts() {
  const texts: string[] = []
  const seen = new Set<string>()
  for (const item of downloadFailList.value) {
    const text = item.raw?.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    texts.push(text)
  }
  if (!texts.length) {
    message.warning('没有可复制的下载失败文案')
    return
  }
  copyText(texts.join('\n'), `已复制 ${texts.length} 条下载失败文案`)
}

async function downloadUrlsWithQueue(urls: string[], concurrency = DOWNLOAD_CONCURRENCY, gapMs = DOWNLOAD_GAP_MS) {
  downloadSaveTotal.value = urls.length
  downloadSaveDone.value = 0
  let cursor = 0
  let finished = 0

  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= urls.length) return
      downloadProxy(urls[i])
      finished += 1
      downloadSaveDone.value = finished
      if (cursor < urls.length) await sleep(gapMs)
    }
  }

  const workers = Math.min(concurrency, urls.length)
  if (workers > 0) {
    await Promise.all(Array.from({ length: workers }, () => worker()))
  }
}

/** 本轮尝试后同步失败重试列表：成功的移出，仍失败的写入/更新 */
function syncDownloadFailsAfterSave(attempted: DownloadJob[], failed: DownloadFailItem[]) {
  const attemptedKeys = new Set(
    attempted.map((a) => failKey(a))
  )
  const kept = downloadFailList.value.filter((i) => !attemptedKeys.has(failKey(i)))
  downloadFailList.value = [...kept, ...failed]
}

function failKey(item: { url: string; itemId?: string; kind?: string; imageIndex?: number }) {
  if (item.itemId && item.kind === 'image' && item.imageIndex != null) {
    return `${item.itemId}:img:${item.imageIndex}`
  }
  if (item.itemId && item.kind === 'video') {
    return `${item.itemId}:video`
  }
  return item.url
}

function clearDownloadFails() {
  downloadFailList.value = []
}

function removeDownloadFail(item: DownloadFailItem) {
  const key = failKey(item)
  downloadFailList.value = downloadFailList.value.filter((i) => failKey(i) !== key)
}

function toFailItem(job: DownloadJob, reason: string): DownloadFailItem {
  return {
    url: job.url,
    label: job.label,
    reason,
    raw: job.raw,
    itemId: job.itemId,
    kind: job.kind,
    imageIndex: job.imageIndex
  }
}

/** 下载前确保代理链接未临近过期；过期则重新解析 */
async function ensureFreshForDownload(item: QueueItem, force = false): Promise<boolean> {
  if (!force && !isTokenStale(item.result)) return item.status === 'done' && !!item.result
  downloadSaveLabel.value = `链接即将过期，重新解析：${shortUrl(item.raw)}`
  downloadSaveFailHint.value = ''
  await parseOne(item)
  // 批量刷新时拉开间隔，降低触发解析限流概率
  await sleep(BATCH_GAP_MS)
  return item.status === 'done' && !!item.result
}

/** 同一条目的并发下载共享一次重解析，避免图集多图同时 404 时重复打解析接口 */
function createRefreshCoordinator() {
  const inflight = new Map<string, Promise<boolean>>()
  return (item: QueueItem, force = false) => {
    if (!force && !isTokenStale(item.result)) {
      return Promise.resolve(item.status === 'done' && !!item.result)
    }
    const existing = inflight.get(item.id)
    if (existing) return existing
    const task = ensureFreshForDownload(item, force).finally(() => {
      inflight.delete(item.id)
    })
    inflight.set(item.id, task)
    return task
  }
}

function findQueueItemForJob(job: DownloadJob): QueueItem | undefined {
  if (job.itemId) return queue.value.find((i) => i.id === job.itemId)
  const raw = job.raw?.trim()
  if (raw) return queue.value.find((i) => i.raw.trim() === raw)
  return undefined
}

type DownloadWork = {
  originalJob: DownloadJob
  job: DownloadJob
  item?: QueueItem
}

/**
 * 按队列条目边刷新边下载：选文件夹一次，临近过期先批量重解析；
 * 文件写入有限并发；遇到 404/过期再自动重解析并重试该文件一次。
 */
async function saveJobsWithLiveRefresh(jobs: DownloadJob[]): Promise<void> {
  if (!jobs.length) return

  downloadSaveDone.value = 0
  downloadSaveTotal.value = jobs.length
  downloadSaveLabel.value = ''
  downloadSaveFailHint.value = ''

  const groups = groupJobsByItem(jobs)
  const refreshShared = createRefreshCoordinator()

  /** 预刷新临近过期条目，再展开最终下载任务 */
  async function prepareWorkList(): Promise<{ work: DownloadWork[]; failed: DownloadFailItem[] }> {
    const failed: DownloadFailItem[] = []
    const staleItems = groups
      .map((g) => g.item)
      .filter((item): item is QueueItem => !!item && isTokenStale(item.result))

    if (staleItems.length) {
      downloadSaveLabel.value = `下载前刷新即将过期的链接（${staleItems.length}）`
      let cursor = 0
      async function refreshWorker() {
        while (true) {
          const i = cursor++
          if (i >= staleItems.length) return
          await refreshShared(staleItems[i], true)
        }
      }
      const n = Math.min(BATCH_CONCURRENCY, staleItems.length)
      await Promise.all(Array.from({ length: n }, () => refreshWorker()))
    }

    const work: DownloadWork[] = []
    for (const group of groups) {
      const item = group.item
      if (item && (item.status !== 'done' || !item.result)) {
        for (const job of group.jobs) {
          failed.push(toFailItem(job, item.error || '重新解析失败'))
        }
        continue
      }

      for (const originalJob of group.jobs) {
        const mapped = item ? resolveJobAfterRefresh(item, originalJob) || originalJob : originalJob
        work.push({ originalJob, job: mapped, item })
      }
    }
    return { work, failed }
  }

  if (!canUseDirectoryPicker()) {
    const { work, failed } = await prepareWorkList()
    syncDownloadFailsAfterSave(jobs, failed)
    const freshUrls = work.map((w) => w.job.url)
    if (!freshUrls.length) {
      dialog?.info({
        title: '下载结果',
        content: `全部需重新解析后仍失败，已加入失败重试列表（${failed.length}）`,
        positiveText: '知道了'
      })
      return
    }
    message.info('当前浏览器不支持选文件夹，将队列批量触发下载（可能需允许「多个下载」）')
    await downloadUrlsWithQueue(freshUrls)
    if (failed.length) {
      dialog?.info({
        title: '下载结果',
        content: `已触发下载 ${freshUrls.length} 个，${failed.length} 个已加入失败重试列表`,
        positiveText: '知道了'
      })
    } else {
      dialog?.info({
        title: '下载结果',
        content: `已触发下载（${freshUrls.length} 个文件）`,
        positiveText: '知道了'
      })
    }
    return
  }

  const picked = await pickDownloadFolder()
  if (!picked.ok) {
    if ('cancelled' in picked && picked.cancelled) {
      message.info('已取消选择文件夹')
      return
    }
    if ('denied' in picked && picked.denied) {
      message.error('浏览器未授权写入所选文件夹，请重新选择并允许访问')
      return
    }
    message.info('当前浏览器不支持选文件夹，将队列批量触发下载（可能需允许「多个下载」）')
    await downloadUrlsWithQueue(jobs.map((j) => j.url))
    dialog?.info({
      title: '下载结果',
      content: `已触发下载（${jobs.length} 个文件）`,
      positiveText: '知道了'
    })
    return
  }

  const { work, failed: prepFailed } = await prepareWorkList()
  const dir = picked.dir
  const usedNames = new Set<string>()
  const failed: DownloadFailItem[] = [...prepFailed]
  let ok = 0
  let finished = prepFailed.length
  downloadSaveDone.value = finished

  if (!work.length) {
    syncDownloadFailsAfterSave(jobs, failed)
    dialog?.info({
      title: '下载结果',
      content: `全部保存失败，已加入失败重试列表（${failed.length}）`,
      positiveText: '知道了'
    })
    return
  }

  let cursor = 0
  async function downloadWorker() {
    while (true) {
      const i = cursor++
      if (i >= work.length) return
      const entry = work[i]
      let job = entry.job
      const item = entry.item

      downloadSaveLabel.value = job.label
      downloadSaveFailHint.value = ''

      let result = await writeOneUrlToDirectory(
        dir,
        { url: mediaDownloadUrl(job.url), label: job.label },
        { index: i, usedNames }
      )

      if (!result.ok && item && isExpiredDownloadReason(result.reason)) {
        downloadSaveFailHint.value = `链接过期，正在重新解析：${shortUrl(item.raw)}`
        const fresh = await refreshShared(item, true)
        if (fresh) {
          const mapped = resolveJobAfterRefresh(item, entry.originalJob)
          if (mapped) {
            job = mapped
            downloadSaveLabel.value = job.label
            result = await writeOneUrlToDirectory(
              dir,
              { url: mediaDownloadUrl(job.url), label: job.label },
              { index: i, usedNames }
            )
          }
        }
      }

      finished += 1
      downloadSaveDone.value = Math.min(finished, downloadSaveTotal.value)

      if (result.ok) {
        ok += 1
      } else {
        downloadSaveFailHint.value = `已跳过：${job.label}（${result.reason}）`
        failed.push(toFailItem(job, result.reason))
      }
    }
  }

  const workers = Math.min(DOWNLOAD_CONCURRENCY, work.length)
  await Promise.all(Array.from({ length: workers }, () => downloadWorker()))

  syncDownloadFailsAfterSave(jobs, failed)

  if (failed.length === 0) {
    dialog?.info({
      title: '下载结果',
      content: `已保存 ${ok} 个文件到所选文件夹`,
      positiveText: '知道了'
    })
  } else if (ok === 0) {
    dialog?.info({
      title: '下载结果',
      content: `全部保存失败，已加入失败重试列表（${failed.length}）`,
      positiveText: '知道了'
    })
  } else {
    dialog?.info({
      title: '下载结果',
      content: `已保存 ${ok} 个，${failed.length} 个已加入失败重试列表`,
      positiveText: '知道了'
    })
  }
}

function groupJobsByItem(jobs: DownloadJob[]): Array<{ item?: QueueItem; jobs: DownloadJob[] }> {
  const order: string[] = []
  const map = new Map<string, DownloadJob[]>()
  for (const job of jobs) {
    const key = job.itemId || job.raw || job.url
    if (!map.has(key)) {
      map.set(key, [])
      order.push(key)
    }
    map.get(key)!.push(job)
  }
  return order.map((key) => {
    const groupJobs = map.get(key)!
    return { item: findQueueItemForJob(groupJobs[0]), jobs: groupJobs }
  })
}

/** 简单批量（单条图集等）：不强制按过期刷新，但仍处理 404 重解析 */
async function saveUrlsPreferFolder(jobs: DownloadJob[] | string[]): Promise<void> {
  const items: DownloadJob[] = jobs.map((j) =>
    typeof j === 'string' ? { url: j, label: '' } : j
  )
  await saveJobsWithLiveRefresh(items)
}

async function onDownloadAllImages(result: ParseResult) {
  const images = result.imageProxyUrls ?? []
  if (!images.length) return
  if (downloadingAll.value) return
  const owner = queue.value.find((i) => i.result === result)
  if (owner) {
    downloadingAll.value = true
    try {
      await ensureFreshForDownload(owner)
      if (owner.status !== 'done' || !owner.result) {
        message.error(owner.error || '重新解析失败，无法下载')
        return
      }
      const index = queue.value.findIndex((i) => i.id === owner.id)
      await saveJobsWithLiveRefresh(jobsFromQueueItem(owner, index >= 0 ? index : 0))
    } catch (err) {
      message.error(err instanceof Error ? err.message : '批量保存失败')
    } finally {
      downloadingAll.value = false
      downloadSaveDone.value = 0
      downloadSaveTotal.value = 0
      downloadSaveLabel.value = ''
      downloadSaveFailHint.value = ''
    }
    return
  }
  downloadingAll.value = true
  try {
    await saveUrlsPreferFolder(
      images.map((url, i) => ({
        url,
        label: `图${i + 1}/${images.length} · ${result.title?.trim() || '未命名图文'}`,
        kind: 'image' as const,
        imageIndex: i
      }))
    )
  } catch (err) {
    message.error(err instanceof Error ? err.message : '批量保存失败')
  } finally {
    downloadingAll.value = false
    downloadSaveDone.value = 0
    downloadSaveTotal.value = 0
    downloadSaveLabel.value = ''
    downloadSaveFailHint.value = ''
  }
}

async function onDownloadAll() {
  const jobs = collectDownloadJobs()
  if (!jobs.length) {
    message.warning('没有可下载的内容')
    return
  }
  if (downloadingAll.value) return
  downloadingAll.value = true
  try {
    await saveJobsWithLiveRefresh(jobs)
  } catch (err) {
    message.error(err instanceof Error ? err.message : '批量保存失败')
  } finally {
    downloadingAll.value = false
    downloadSaveDone.value = 0
    downloadSaveTotal.value = 0
    downloadSaveLabel.value = ''
    downloadSaveFailHint.value = ''
  }
}

async function retryDownloadFailed() {
  const fails = [...downloadFailList.value]
  if (!fails.length) {
    message.warning('当前没有下载失败项')
    return
  }
  if (downloadingAll.value) return
  downloadingAll.value = true
  try {
    // 失败重试：先强制按条目重新解析，再用新链接下载
    const jobs: DownloadJob[] = []
    const groups = new Map<string, DownloadFailItem[]>()
    for (const fail of fails) {
      const key = fail.itemId || fail.raw || fail.url
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(fail)
    }

    downloadSaveTotal.value = fails.length
    downloadSaveDone.value = 0

    for (const groupFails of groups.values()) {
      const seed = groupFails[0]
      let item = findQueueItemForJob(seed)
      if (!item && seed.raw?.trim()) {
        // 队列里没有时无法重解析，沿用旧 url
        for (const f of groupFails) {
          jobs.push({
            url: f.url,
            label: f.label,
            raw: f.raw,
            itemId: f.itemId,
            kind: f.kind,
            imageIndex: f.imageIndex
          })
        }
        continue
      }
      if (item) {
        downloadSaveLabel.value = `重试前重新解析：${shortUrl(item.raw)}`
        const ok = await ensureFreshForDownload(item, true)
        if (!ok) {
          // 保留在失败列表（后面 sync 时会写回）
          for (const f of groupFails) {
            jobs.push({
              url: f.url,
              label: f.label,
              raw: f.raw,
              itemId: f.itemId,
              kind: f.kind,
              imageIndex: f.imageIndex
            })
          }
          continue
        }
        const index = queue.value.findIndex((q) => q.id === item!.id)
        for (const f of groupFails) {
          const mapped = resolveJobAfterRefresh(item, {
            url: f.url,
            label: f.label,
            raw: f.raw,
            itemId: f.itemId,
            kind: f.kind,
            imageIndex: f.imageIndex
          })
          if (mapped) {
            jobs.push(mapped)
          } else {
            // 图集数量变化等：把该条整项可下载内容补上一次
            const all = jobsFromQueueItem(item, index >= 0 ? index : 0)
            for (const j of all) {
              if (!jobs.some((x) => failKey(x) === failKey(j))) jobs.push(j)
            }
          }
        }
      }
    }

    if (!jobs.length) {
      message.error('重新解析后仍无可下载内容')
      return
    }
    await saveJobsWithLiveRefresh(jobs)
  } catch (err) {
    message.error(err instanceof Error ? err.message : '重试保存失败')
  } finally {
    downloadingAll.value = false
    downloadSaveDone.value = 0
    downloadSaveTotal.value = 0
    downloadSaveLabel.value = ''
    downloadSaveFailHint.value = ''
  }
}

async function retryOneDownload(item: DownloadFailItem) {
  if (downloadingAll.value) return
  downloadingAll.value = true
  try {
    const queueItem = findQueueItemForJob(item)
    if (queueItem) {
      downloadSaveLabel.value = `重试前重新解析：${shortUrl(queueItem.raw)}`
      await ensureFreshForDownload(queueItem, true)
      if (queueItem.status === 'done' && queueItem.result) {
        const mapped = resolveJobAfterRefresh(queueItem, {
          url: item.url,
          label: item.label,
          raw: item.raw,
          itemId: item.itemId,
          kind: item.kind,
          imageIndex: item.imageIndex
        })
        if (mapped) {
          await saveJobsWithLiveRefresh([mapped])
          return
        }
      }
    }
    await saveJobsWithLiveRefresh([
      {
        url: item.url,
        label: item.label,
        raw: item.raw,
        itemId: item.itemId,
        kind: item.kind,
        imageIndex: item.imageIndex
      }
    ])
  } catch (err) {
    message.error(err instanceof Error ? err.message : '重试保存失败')
  } finally {
    downloadingAll.value = false
    downloadSaveDone.value = 0
    downloadSaveTotal.value = 0
    downloadSaveLabel.value = ''
    downloadSaveFailHint.value = ''
  }
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

async function retryFailed() {
  if (loading.value) return
  const targets = queue.value.filter((i) => i.status === 'error')
  if (!targets.length) {
    message.warning('当前没有失败项')
    return
  }

  loading.value = true
  progressDone.value = 0
  progressTotal.value = targets.length

  try {
    await runParsePool(targets)
    await nextTick()
    const stillFail = targets.filter((i) => i.status === 'error').length
    const recovered = targets.length - stillFail
    if (recovered && !stillFail) message.success(`全部重试成功（${recovered}）`)
    else if (recovered && stillFail) message.warning(`重试完成：成功 ${recovered}，仍失败 ${stillFail}`)
    else message.error(`全部仍失败（${stillFail}）`)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="page">
    <main class="shell">
      <header class="hero">
        <p class="brand">清影解析</p>
        <h1 class="headline">粘贴分享链接，批量获取可预览与下载的视频 / 图集</h1>
        <p class="sub">
          支持抖音、小红书。一次最多 {{ MAX_QUEUE }} 条；下载全部时若链接临近过期会自动重新解析。
        </p>
      </header>

      <section class="panel">
        <div class="panel-head">
          <label class="label" for="share-input">批量粘贴</label>
          <span class="hint-inline">每行一条 · 最多 {{ MAX_QUEUE }} 条 · Ctrl/⌘ + Enter 开始</span>
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
          <p class="label">待解析列表（{{ queue.length }}/{{ MAX_QUEUE }}）</p>
          <div class="panel-head-actions">
            <NButton
              v-if="failCount > 0"
              size="tiny"
              secondary
              :disabled="loading"
              @click="copyFailedTexts"
            >
              复制失败文案（{{ failCount }}）
            </NButton>
            <NButton
              v-if="failCount > 0"
              size="tiny"
              type="warning"
              secondary
              :disabled="loading"
              @click="retryFailed"
            >
              重试失败（{{ failCount }}）
            </NButton>
            <NButton
              size="tiny"
              quaternary
              :disabled="loading || queueAtLimit"
              @click="addEmptyRow"
            >
              添加一行
            </NButton>
          </div>
        </div>
        <div class="queue-table" role="table">
          <div class="queue-row queue-head" role="row">
            <span class="col-idx">#</span>
            <span class="col-raw">分享文案 / 链接</span>
            <span class="col-status">状态</span>
            <span class="col-act">操作</span>
          </div>
          <div
            v-for="(item, index) in queue"
            :id="`queue-${item.id}`"
            :key="item.id"
            class="queue-row"
            :class="{ 'is-target': highlightId === item.id }"
            role="row"
          >
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
                v-if="item.status === 'done' || item.status === 'error'"
                type="button"
                class="link-btn"
                @click="locateResult(item)"
              >
                查看
              </button>
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

      <section
        v-if="loading || progressTotal > 0"
        ref="progressPanelRef"
        class="panel progress-panel"
      >
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
            <NButton
              v-if="failCount > 0"
              size="small"
              secondary
              :disabled="loading"
              @click="copyFailedTexts"
            >
              复制失败文案（{{ failCount }}）
            </NButton>
            <NButton
              v-if="failCount > 0"
              size="small"
              type="warning"
              secondary
              :disabled="loading"
              @click="retryFailed"
            >
              重试失败（{{ failCount }}）
            </NButton>
            <NButton
              v-if="downloadFailCount > 0"
              size="small"
              type="warning"
              secondary
              :loading="downloadingAll"
              :disabled="downloadingAll || loading"
              @click="retryDownloadFailed"
            >
              重试下载失败（{{ downloadFailCount }}）
            </NButton>
            <NButton
              size="small"
              type="primary"
              :loading="downloadingAll"
              :disabled="!downloadableCount || downloadingAll || loading"
              @click="onDownloadAll"
            >
              <template v-if="downloadingAll && downloadSaveTotal">
                保存中 {{ downloadSaveDone }}/{{ downloadSaveTotal }}
              </template>
              <template v-else>
                下载全部{{ downloadableCount ? `（${downloadableCount}）` : '' }}
              </template>
            </NButton>
            <NButton size="small" quaternary @click="expandAll">全部展开</NButton>
            <NButton size="small" quaternary @click="collapseAll">全部折叠</NButton>
          </div>
        </div>
        <p v-if="downloadingAll && downloadSaveLabel" class="download-current">
          当前：{{ downloadSaveLabel }}
        </p>
        <p v-if="downloadingAll && downloadSaveFailHint" class="download-skip">
          {{ downloadSaveFailHint }}
        </p>

        <div v-if="downloadFailCount" class="download-fail-panel">
          <div class="download-fail-head">
            <p class="download-fail-title">下载失败重试列表（{{ downloadFailCount }}）</p>
            <div class="download-fail-actions">
              <NButton size="tiny" secondary @click="copyDownloadFailedTexts">
                复制失败文案列表
              </NButton>
              <NButton
                size="tiny"
                quaternary
                :disabled="downloadingAll"
                @click="clearDownloadFails"
              >
                清空
              </NButton>
              <NButton
                size="tiny"
                type="warning"
                secondary
                :loading="downloadingAll"
                :disabled="downloadingAll || loading"
                @click="retryDownloadFailed"
              >
                全部重试下载
              </NButton>
            </div>
          </div>
          <ul class="download-fail-list">
            <li v-for="(failItem, failIndex) in downloadFailList" :key="`${failKey(failItem)}-${failIndex}`">
              <div class="download-fail-meta">
                <span class="download-fail-label">{{ failItem.label || `第 ${failIndex + 1} 项` }}</span>
                <span class="download-fail-reason">{{ failItem.reason }}</span>
              </div>
              <div class="download-fail-item-act">
                <button
                  type="button"
                  class="link-btn"
                  :disabled="downloadingAll"
                  @click="retryOneDownload(failItem)"
                >
                  重试
                </button>
                <button
                  type="button"
                  class="link-btn"
                  :disabled="downloadingAll"
                  @click="removeDownloadFail(failItem)"
                >
                  移除
                </button>
              </div>
            </li>
          </ul>
        </div>

        <NCollapse v-model:expanded-names="expandedNames" display-directive="if">
          <NCollapseItem
            v-for="(item, index) in doneItems"
            :key="item.id"
            :name="item.id"
            :title="panelTitle(item, index)"
          >
            <template #header-extra>
              <span
                :id="`result-${item.id}`"
                class="result-anchor"
                :class="{ 'is-target': highlightId === item.id }"
                aria-hidden="true"
              />
              <button
                type="button"
                class="link-btn locate-queue-btn"
                @click.stop="locateQueueRow(item)"
              >
                回到表格
              </button>
            </template>
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
                    <NButton
                      type="primary"
                      :loading="downloadingAll"
                      :disabled="downloadingAll"
                      @click="onDownloadAllImages(item.result)"
                    >
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

    <div class="fab-stack">
      <button
        v-show="showFloatingParseProgress"
        type="button"
        class="parse-progress-fab"
        :aria-label="`解析进度 ${progressPercent}%，点击跳转到进度条`"
        @click="scrollToProgress"
      >
        <NProgress
          type="circle"
          :percentage="progressPercent"
          :processing="loading"
          :stroke-width="8"
          :show-indicator="true"
          class="parse-progress-ring"
        />
      </button>
      <button
        v-show="showBackTop"
        type="button"
        class="back-top"
        aria-label="回到顶部"
        @click="scrollToTop"
      >
        ↑
      </button>
    </div>
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

.panel-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
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
  grid-template-columns: 40px minmax(0, 1fr) 64px auto;
  gap: 12px;
  align-items: center;
  scroll-margin-top: 16px;
  scroll-margin-bottom: 16px;
  transition: box-shadow 0.35s ease, background-color 0.35s ease;
}

.queue-row.is-target {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border-radius: 8px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent);
}

.queue-head {
  color: var(--muted);
  font-size: 0.8rem;
  padding: 0 2px 4px;
  border-bottom: 1px solid var(--line);
  align-items: end;
}

.col-idx,
.col-status,
.col-act {
  color: var(--muted);
  font-size: 0.85rem;
  line-height: 1.4;
}

.col-idx {
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.col-status {
  display: flex;
  justify-content: center;
  align-items: center;
}

.col-act {
  display: flex;
  flex-direction: row;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  white-space: nowrap;
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

.download-current,
.download-skip {
  margin: -4px 4px 0;
  font-size: 0.82rem;
  line-height: 1.45;
  word-break: break-all;
}

.download-current {
  color: var(--muted);
}

.download-skip {
  color: var(--danger);
}

.download-fail-panel {
  margin: 0 4px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--line));
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--danger) 8%, rgba(16, 32, 28, 0.72));
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.download-fail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.download-fail-title {
  margin: 0;
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--ink);
}

.download-fail-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.download-fail-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 220px;
  overflow: auto;
}

.download-fail-list li {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-top: 1px solid var(--line);
}

.download-fail-list li:first-child {
  border-top: 0;
  padding-top: 0;
}

.download-fail-meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.download-fail-label {
  font-size: 0.86rem;
  color: var(--ink);
  word-break: break-word;
}

.download-fail-reason {
  font-size: 0.8rem;
  color: var(--danger);
  word-break: break-word;
}

.download-fail-item-act {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  padding-top: 2px;
}

.toolbar-actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
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
  scroll-margin-top: 16px;
  transition: box-shadow 0.35s ease, border-color 0.35s ease;
}

.results-wrap :deep(.n-collapse-item:has(.result-anchor.is-target)) {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent), var(--shadow);
}

.result-anchor {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
  pointer-events: none;
}

.results-wrap :deep(.n-collapse-item__header) {
  padding: 14px 16px;
  font-weight: 600;
  color: var(--ink);
}

.results-wrap :deep(.n-collapse-item__header-extra) {
  display: flex;
  align-items: center;
  margin-left: 12px;
}

.locate-queue-btn {
  flex-shrink: 0;
  white-space: nowrap;
  font-weight: 500;
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
  padding: 0;
  font-size: 0.85rem;
  line-height: 1.4;
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

.fab-stack {
  position: fixed;
  right: 56px;
  bottom: 28px;
  z-index: 40;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.parse-progress-fab {
  width: 58px;
  height: 58px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 50%;
  background: rgba(16, 32, 28, 0.92);
  cursor: pointer;
  box-shadow: var(--shadow);
  backdrop-filter: blur(10px);
  display: grid;
  place-items: center;
  transition: border-color 0.2s ease, transform 0.2s ease;
}

.parse-progress-fab:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
  transform: translateY(-2px);
}

.parse-progress-fab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.parse-progress-ring {
  width: 46px !important;
}

.parse-progress-ring :deep(.n-progress-text) {
  font-size: 0.68rem !important;
  color: var(--accent) !important;
}

.back-top {
  width: 58px;
  height: 58px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: rgba(16, 32, 28, 0.92);
  color: var(--accent);
  font-size: 1.45rem;
  line-height: 1;
  cursor: pointer;
  box-shadow: var(--shadow);
  backdrop-filter: blur(10px);
  transition: color 0.2s ease, border-color 0.2s ease, transform 0.2s ease;
}

.back-top:hover {
  color: #45e0b6;
  border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
  transform: translateY(-2px);
}

.back-top:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

@media (max-width: 768px) {
  .page {
    padding: 20px 12px 32px;
  }

  .fab-stack {
    right: 36px;
    bottom: 22px;
  }

  .parse-progress-fab,
  .back-top {
    width: 52px;
    height: 52px;
  }

  .parse-progress-ring {
    width: 40px !important;
  }

  .back-top {
    font-size: 1.3rem;
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
    align-items: center;
  }

  .col-idx {
    grid-area: idx;
  }

  .col-raw {
    grid-area: raw;
  }

  .col-status {
    grid-area: status;
    justify-content: flex-start;
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
