<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NImage, NInput, NProgress, NTag, useDialog, useMessage } from 'naive-ui'
import AppNav from '../components/AppNav.vue'
import {
  canUseDirectoryPicker,
  pickDownloadFolder,
  writeOneBlobToDirectory
} from '../api/folderDownload'
import {
  collectShareEntries,
  downloadImageUrlToFile,
  extractFirstUrl,
  fetchChatImages,
  fetchImagesErrorMessage,
  isFetchRateLimited,
  platformAiLabel,
  proxyUrlToFile,
  type FetchImagesResult
} from '../api/watermarkFetch'
import { extractDoubaoFromHtml } from '../utils/watermark/doubaoHtmlExtract'
import {
  isImageName,
  isVideoName,
  isZipFile,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_VIDEO_BYTES
} from '../utils/watermark/fileRules'
import { extractImagesFromZip } from '../utils/watermark/zipExtract'
import { processImageFile } from '../utils/watermark/processImage'
import type { UploadMode, WatermarkTask } from '../utils/watermark/types'

type LinkStatus = 'idle' | 'fetching' | 'done' | 'error'

interface LinkQueueItem {
  id: string
  raw: string
  status: LinkStatus
  result: FetchImagesResult | null
  error: string | null
  imageCount: number
  title: string | null
}

const message = useMessage()
const dialog = useDialog()

const uploadMode = ref<UploadMode | null>(null)
const tasks = ref<WatermarkTask[]>([])
const processing = ref(false)
const progressDone = ref(0)
const progressTotal = ref(0)
const progressPhase = ref('')
const fileProgress = ref(0)
const fileInputRef = ref<HTMLInputElement | null>(null)

const draft = ref('')
const htmlDraft = ref('')
const linkQueue = ref<LinkQueueItem[]>([])
const fetchingLinks = ref(false)
const linkProgressDone = ref(0)
const linkProgressTotal = ref(0)
const parsingHtml = ref(false)

const downloadingAll = ref(false)
const downloadSaveDone = ref(0)
const downloadSaveTotal = ref(0)
const downloadSaveLabel = ref('')
const downloadSaveFailHint = ref('')

const progressPanelRef = ref<HTMLElement | null>(null)
const linkProgressPanelRef = ref<HTMLElement | null>(null)
const processProgressPanelRef = ref<HTMLElement | null>(null)
const progressPanelInView = ref(true)
const showBackTop = ref(false)
let progressObserver: IntersectionObserver | null = null

const MAX_LINK_QUEUE = 99
const BATCH_CONCURRENCY = 3
const BATCH_GAP_MS = 280
const RATE_LIMIT_BACKOFF_MS = 3500
const RATE_LIMIT_MAX_RETRY = 2

let idSeq = 0
function nextId() {
  idSeq += 1
  return `wm-${idSeq}`
}

let linkIdSeq = 0
function nextLinkId() {
  linkIdSeq += 1
  return `link-${linkIdSeq}`
}

const hasTasks = computed(() => tasks.value.length > 0)
const doneCount = computed(() => tasks.value.filter((t) => t.status === 'done').length)
const failCount = computed(() => tasks.value.filter((t) => t.status === 'error').length)
const hasDraft = computed(() => draft.value.trim().length > 0)
const hasLinkQueue = computed(() => linkQueue.value.length > 0)
const linkQueueAtLimit = computed(() => linkQueue.value.length >= MAX_LINK_QUEUE)
const linkFailCount = computed(() => linkQueue.value.filter((i) => i.status === 'error').length)
const linkSuccessCount = computed(() => linkQueue.value.filter((i) => i.status === 'done').length)
const busy = computed(() => processing.value || fetchingLinks.value || parsingHtml.value)
const hasHtmlDraft = computed(() => htmlDraft.value.trim().length > 200)
const isLocalEnv = computed(() => {
  if (import.meta.env.DEV) return true
  if (typeof window === 'undefined') return false
  const host = window.location.hostname
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
})

/** Render 等线上环境暂不展示云端拉链接（机房访问豆包常失败） */
const showAiLinkFetch = isLocalEnv

const processPercent = computed(() => {
  if (!progressTotal.value) return 0
  return Math.min(
    100,
    Math.round(((progressDone.value + fileProgress.value / 100) / progressTotal.value) * 100)
  )
})

const linkPercent = computed(() => {
  if (!linkProgressTotal.value) return 0
  return Math.min(100, Math.round((linkProgressDone.value / linkProgressTotal.value) * 100))
})

/** 浮动环形进度：拉图或去水印进行中时取当前活动进度 */
const floatingPercent = computed(() => {
  if ((fetchingLinks.value || parsingHtml.value) && linkProgressTotal.value > 0) return linkPercent.value
  if (processing.value && progressTotal.value > 0) return processPercent.value
  return 0
})

const showFloatingProgress = computed(
  () =>
    (((fetchingLinks.value || parsingHtml.value) && linkProgressTotal.value > 0) ||
      (processing.value && progressTotal.value > 0)) &&
    !progressPanelInView.value
)

const acceptAttr = computed(() => {
  if (uploadMode.value === 'zip') return '.zip'
  if (uploadMode.value === 'video') return '.mp4,.webm,.mov,video/*'
  if (uploadMode.value === 'images') return '.jpg,.jpeg,.png,.webp,.bmp,image/*'
  return '.jpg,.jpeg,.png,.webp,.bmp,.zip,.mp4,.webm,.mov,image/*,video/*'
})

const modeHint = computed(() => {
  if (!uploadMode.value) {
    return showAiLinkFetch.value
      ? '一次仅选一种类型：多张图片 / 单个 zip / 单个视频；也可粘贴 AI 聊天链接拉图'
      : '一次仅选一种类型：多张图片 / 单个 zip / 单个视频；也可粘贴网页源码提取原图'
  }
  if (uploadMode.value === 'images') return `已选图片模式 · 最多 ${MAX_IMAGES} 张 · 单张 ≤ ${MAX_IMAGE_BYTES / 1024 / 1024}MB`
  if (uploadMode.value === 'zip') return '已选 zip 模式 · 仅 1 个压缩包 · 内含图片数量不限制'
  return `已选视频模式 · 仅 1 个文件 · ≤ ${MAX_VIDEO_BYTES / 1024 / 1024}MB · 时长 ≤ 45 秒 · 保留原声`
})

function revokeTaskUrls(task: WatermarkTask) {
  if (task.originalUrl) URL.revokeObjectURL(task.originalUrl)
  if (task.resultUrl) URL.revokeObjectURL(task.resultUrl)
  if (task.maskPreviewUrl?.startsWith('blob:')) URL.revokeObjectURL(task.maskPreviewUrl)
}

function clearTasks() {
  for (const task of tasks.value) revokeTaskUrls(task)
  tasks.value = []
  uploadMode.value = null
  progressDone.value = 0
  progressTotal.value = 0
  progressPhase.value = ''
  fileProgress.value = 0
}

function clearAll() {
  clearTasks()
  draft.value = ''
  htmlDraft.value = ''
  linkQueue.value = []
  linkProgressDone.value = 0
  linkProgressTotal.value = 0
}

function detectModeFromFile(file: File): UploadMode {
  if (isZipFile(file)) return 'zip'
  if (isVideoName(file.name) || file.type.startsWith('video/')) return 'video'
  return 'images'
}

function ensureMode(file: File): UploadMode | null {
  const mode = detectModeFromFile(file)
  if (!uploadMode.value) {
    uploadMode.value = mode
    return mode
  }
  if (uploadMode.value !== mode) {
    message.warning('一次只能上传一种类型，请先清空再换类型')
    return null
  }
  return mode
}

function ensureImagesModeForLinks(): boolean {
  if (!uploadMode.value) {
    uploadMode.value = 'images'
    return true
  }
  if (uploadMode.value !== 'images') {
    message.warning('当前是 zip / 视频模式，请先清空再使用链接拉图')
    return false
  }
  return true
}

function addImageTask(file: File, options?: { fromZip?: boolean }): boolean {
  const fromZip = options?.fromZip === true
  if (!fromZip && file.size > MAX_IMAGE_BYTES) {
    message.error(`${file.name} 超过单张大小限制`)
    return false
  }
  if (!isImageName(file.name) && !file.type.startsWith('image/')) {
    message.error(`${file.name} 不是支持的图片格式`)
    return false
  }
  if (!fromZip && tasks.value.length >= MAX_IMAGES) {
    message.warning(`最多 ${MAX_IMAGES} 张图片`)
    return false
  }
  tasks.value.push({
    id: nextId(),
    name: file.name,
    kind: 'image',
    sourceFile: file,
    status: 'pending',
    error: null,
    originalUrl: URL.createObjectURL(file),
    resultUrl: null,
    resultBlob: null,
    maskPreviewUrl: null,
    regionLabel: null
  })
  return true
}

function addVideoTask(file: File) {
  if (file.size > MAX_VIDEO_BYTES) {
    message.error('视频文件过大')
    return
  }
  if (!isVideoName(file.name) && !file.type.startsWith('video/')) {
    message.error('不支持的视频格式')
    return
  }
  if (tasks.value.length >= 1) {
    message.warning('视频模式仅支持 1 个文件')
    return
  }
  tasks.value.push({
    id: nextId(),
    name: file.name,
    kind: 'video',
    sourceFile: file,
    status: 'pending',
    error: null,
    originalUrl: URL.createObjectURL(file),
    resultUrl: null,
    resultBlob: null,
    maskPreviewUrl: null,
    regionLabel: null
  })
}

async function addZipTask(file: File) {
  if (tasks.value.length >= 1) {
    message.warning('zip 模式仅支持 1 个压缩包')
    return
  }
  try {
    const images = await extractImagesFromZip(file)
    uploadMode.value = 'zip'
    for (const img of images) addImageTask(img, { fromZip: true })
    message.success(`已从压缩包读取 ${images.length} 张图片`)
  } catch (e) {
    message.error(e instanceof Error ? e.message : '压缩包解析失败')
  }
}

async function onFilesSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length) return

  for (const file of files) {
    const mode = ensureMode(file)
    if (!mode) return
    if (mode === 'zip') {
      if (files.length > 1) {
        message.warning('zip 模式一次只能选 1 个压缩包')
        return
      }
      await addZipTask(file)
      continue
    }
    if (mode === 'video') {
      if (files.length > 1) {
        message.warning('视频模式一次只能选 1 个文件')
        return
      }
      addVideoTask(file)
      continue
    }
    addImageTask(file)
  }
}

function openPicker() {
  fileInputRef.value?.click()
}

function makeLinkItem(raw: string): LinkQueueItem {
  return {
    id: nextLinkId(),
    raw,
    status: 'idle',
    result: null,
    error: null,
    imageCount: 0,
    title: null
  }
}

function takeEntriesWithCap(entries: string[]) {
  if (entries.length <= MAX_LINK_QUEUE) return entries
  message.warning(`一次最多 ${MAX_LINK_QUEUE} 条，已截取前 ${MAX_LINK_QUEUE} 条`)
  return entries.slice(0, MAX_LINK_QUEUE)
}

function syncQueueFromDraft() {
  const collected = collectShareEntries(draft.value)
  if (!collected.length) {
    message.warning('未识别到有效链接，请检查粘贴内容')
    return
  }
  linkQueue.value = takeEntriesWithCap(collected).map(makeLinkItem)
  message.success(`已整理 ${linkQueue.value.length} 条链接`)
}

function addEmptyLinkRow() {
  if (linkQueue.value.length >= MAX_LINK_QUEUE) {
    message.warning(`列表最多 ${MAX_LINK_QUEUE} 条`)
    return
  }
  linkQueue.value.push(makeLinkItem(''))
}

function removeLinkRow(id: string) {
  linkQueue.value = linkQueue.value.filter((i) => i.id !== id)
}

function onClearLinks() {
  draft.value = ''
  linkQueue.value = []
  linkProgressDone.value = 0
  linkProgressTotal.value = 0
}

async function onParseHtmlDraft() {
  const html = htmlDraft.value.trim()
  if (!html || html.length < 200) {
    message.warning('请粘贴完整的豆包页面源码（右键 → 查看网页源代码 → 全选复制）')
    return
  }
  if (uploadMode.value && uploadMode.value !== 'images') {
    message.warning('当前是 zip / 视频模式，请先清空再使用')
    return
  }
  if (busy.value) return

  const extracted = extractDoubaoFromHtml(html)
  if (!extracted.urls.length) {
    const hasShare = /share_info|share_name|message_snapshot/i.test(html)
    message.error(
      hasShare
        ? '源码里有分享数据，但未解析到图片链接。请用 Ctrl+A 全选整页源码再复制（图片数据通常在页面最底部）。'
        : '源码中未找到图片。请确认：右键「查看网页源代码」（不是检查元素），Ctrl+A 全选后复制。'
    )
    return
  }
  if (!ensureImagesModeForLinks()) return

  parsingHtml.value = true
  linkProgressDone.value = 0
  linkProgressTotal.value = extracted.urls.length
  const groupTitle = (extracted.title || '豆包源码').trim()
  const titleBase = groupTitle.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40)
  let added = 0
  try {
    for (let i = 0; i < extracted.urls.length; i++) {
      if (tasks.value.length >= MAX_IMAGES) {
        message.warning(`已达图片上限 ${MAX_IMAGES} 张，后续已跳过`)
        break
      }
      const filename = `${titleBase}_${i + 1}`
      try {
        const file = await downloadImageUrlToFile(extracted.urls[i], filename)
        if (addImageTask(file)) added += 1
      } catch (err) {
        const msg = err instanceof Error ? err.message : '下载失败'
        message.warning(`${filename}：${msg}`)
      }
      linkProgressDone.value = i + 1
    }
    if (!added) {
      message.error('未能加入任何图片（可能被浏览器跨域拦截，可改用本地保存后上传）')
      return
    }
    message.success(`已从源码提取 ${added} 张无水印原图`)
    dialog.info({
      title: '提取完成',
      content: `共 ${added} 张图片。是否立即开始去水印？`,
      positiveText: '开始去水印',
      negativeText: '暂不',
      onPositiveClick: () => {
        void onStartProcess()
      }
    })
  } finally {
    parsingHtml.value = false
  }
}

async function onPasteAndFill() {
  try {
    const text = await navigator.clipboard.readText()
    if (!text?.trim()) {
      message.warning('剪贴板为空')
      return
    }
    const collected = collectShareEntries(text)
    if (!collected.length) {
      message.warning('剪贴板中未识别到链接')
      return
    }
    const existing = new Set(
      linkQueue.value.map((i) => (extractFirstUrl(i.raw) || i.raw).toLowerCase()).filter(Boolean)
    )
    const toAdd: string[] = []
    for (const entry of collected) {
      const key = (extractFirstUrl(entry) || entry).toLowerCase()
      if (existing.has(key)) continue
      existing.add(key)
      toAdd.push(entry)
      if (linkQueue.value.length + toAdd.length >= MAX_LINK_QUEUE) break
    }
    if (!toAdd.length) {
      message.info('没有新的链接可追加')
      return
    }
    linkQueue.value.push(...toAdd.map(makeLinkItem))
    message.success(`已追加 ${toAdd.length} 条`)
  } catch {
    message.error('无法读取剪贴板，请手动粘贴到输入框')
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    void onBatchFetchLinks()
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

async function ingestFetchedImages(item: LinkQueueItem, result: FetchImagesResult) {
  const urls = result.imageProxyUrls || []
  if (!urls.length) {
    throw new Error('未获取到图片')
  }
  if (!ensureImagesModeForLinks()) {
    throw new Error('当前模式不支持链接拉图')
  }

  const platform = platformAiLabel(result.platform)
  const groupTitle = (result.title || platform).trim() || platform
  const titleBase = groupTitle.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40)
  let added = 0
  // 顺序拉取，避免大图并发打满代理 / 浏览器
  for (let i = 0; i < urls.length; i++) {
    if (tasks.value.length >= MAX_IMAGES) {
      message.warning(`已达图片上限 ${MAX_IMAGES} 张，后续图片已跳过`)
      break
    }
    const filename = `${titleBase}_${i + 1}`
    try {
      const file = await proxyUrlToFile(urls[i], filename)
      if (addImageTask(file)) added += 1
    } catch (err) {
      const msg = err instanceof Error ? err.message : '下载失败'
      message.warning(`${filename}：${msg}`)
    }
  }
  item.imageCount = added
  item.title = groupTitle
  if (!added) throw new Error('未能加入任何图片任务')
}

async function fetchOneLink(item: LinkQueueItem) {
  const raw = item.raw.trim()
  if (!raw || !extractFirstUrl(raw)) {
    item.status = 'error'
    item.error = '无效链接'
    item.result = null
    item.imageCount = 0
    item.title = null
    return
  }
  item.status = 'fetching'
  item.error = null
  item.imageCount = 0
  item.title = null
  let attempt = 0
  while (true) {
    try {
      const result = await fetchChatImages(raw)
      await ingestFetchedImages(item, result)
      item.result = result
      item.status = 'done'
      return
    } catch (err) {
      if (isFetchRateLimited(err) && attempt < RATE_LIMIT_MAX_RETRY) {
        attempt += 1
        await sleep(RATE_LIMIT_BACKOFF_MS * attempt)
        continue
      }
      item.result = null
      item.status = 'error'
      item.error = err instanceof Error && !isFetchRateLimited(err)
        ? err.message || fetchImagesErrorMessage(err)
        : fetchImagesErrorMessage(err)
      item.imageCount = 0
      item.title = null
      return
    }
  }
}

async function runFetchPool(targets: LinkQueueItem[]) {
  let cursor = 0
  let finished = 0

  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= targets.length) return
      await fetchOneLink(targets[i])
      finished += 1
      linkProgressDone.value = finished
      if (cursor < targets.length) await sleep(BATCH_GAP_MS)
    }
  }

  const workers = Math.min(BATCH_CONCURRENCY, targets.length)
  await Promise.all(Array.from({ length: workers }, () => worker()))
}

async function onBatchFetchLinks() {
  if (fetchingLinks.value || processing.value) return

  if (uploadMode.value && uploadMode.value !== 'images') {
    message.warning('当前是 zip / 视频模式，请先清空再使用链接拉图')
    return
  }

  const collected = collectShareEntries(draft.value)
  if (collected.length) {
    linkQueue.value = takeEntriesWithCap(collected).map(makeLinkItem)
  } else if (!linkQueue.value.length) {
    message.warning('请先粘贴链接，或整理到下方列表')
    return
  } else if (linkQueue.value.length > MAX_LINK_QUEUE) {
    const dropped = linkQueue.value.length - MAX_LINK_QUEUE
    linkQueue.value = linkQueue.value.slice(0, MAX_LINK_QUEUE)
    message.warning(`列表最多 ${MAX_LINK_QUEUE} 条，已截取前 ${MAX_LINK_QUEUE} 条，超出 ${dropped} 条未保留`)
  }

  const targets = linkQueue.value.filter((i) => i.raw.trim())
  if (!targets.length) {
    message.warning('列表中没有有效内容')
    return
  }

  fetchingLinks.value = true
  linkProgressDone.value = 0
  linkProgressTotal.value = targets.length
  for (const item of targets) {
    item.status = 'idle'
    item.result = null
    item.error = null
    item.imageCount = 0
    item.title = null
  }

  try {
    await runFetchPool(targets)
    const ok = linkSuccessCount.value
    const bad = linkFailCount.value
    const imgTotal = linkQueue.value.reduce((n, i) => n + (i.imageCount || 0), 0)
    if (ok && !bad) {
      dialog.info({
        title: '拉取完成',
        content: `成功 ${ok} 条链接，共 ${imgTotal} 张图片。是否立即开始去水印？`,
        positiveText: '开始去水印',
        negativeText: '稍后',
        onPositiveClick: () => {
          void onStartProcess()
        }
      })
    } else if (ok && bad) {
      dialog.info({
        title: '拉取完成',
        content: `成功 ${ok} 条（${imgTotal} 张图），失败 ${bad}。是否对已成功的图片开始去水印？`,
        positiveText: '开始去水印',
        negativeText: '稍后',
        onPositiveClick: () => {
          void onStartProcess()
        }
      })
    } else {
      message.error(`全部失败（${bad}）`)
    }
  } finally {
    fetchingLinks.value = false
  }
}

async function retryFailedLinks() {
  const targets = linkQueue.value.filter((i) => i.status === 'error')
  if (!targets.length) {
    message.info('没有失败项')
    return
  }
  if (uploadMode.value && uploadMode.value !== 'images') {
    message.warning('当前是 zip / 视频模式，请先清空再使用链接拉图')
    return
  }
  fetchingLinks.value = true
  linkProgressDone.value = 0
  linkProgressTotal.value = targets.length
  try {
    await runFetchPool(targets)
    message.success(`重试完成：成功 ${linkSuccessCount.value}，失败 ${linkFailCount.value}`)
  } finally {
    fetchingLinks.value = false
  }
}

function copyFailedLinkTexts() {
  const texts = linkQueue.value
    .filter((i) => i.status === 'error')
    .map((i) => i.raw.trim())
    .filter(Boolean)
  if (!texts.length) return
  void navigator.clipboard.writeText(texts.join('\n')).then(
    () => message.success(`已复制 ${texts.length} 条失败文案`),
    () => message.error('复制失败')
  )
}

async function processOne(task: WatermarkTask) {
  task.status = 'processing'
  task.error = null
  fileProgress.value = 0
  progressPhase.value = task.kind === 'image' ? 'Worker 处理图片中' : '准备处理视频'
  try {
    if (task.kind === 'image') {
      const result = await processImageFile(task.sourceFile)
      if (task.resultUrl) URL.revokeObjectURL(task.resultUrl)
      task.resultBlob = result.blob
      task.resultUrl = result.previewUrl
      task.maskPreviewUrl = result.maskPreviewUrl
      task.regionLabel = result.regionLabel
      task.status = 'done'
      fileProgress.value = 100
    } else {
      const { processVideoFile } = await import('../utils/watermark/processVideo')
      const result = await processVideoFile(task.sourceFile, (p, phase) => {
        fileProgress.value = p
        if (phase) progressPhase.value = phase
      })
      if (task.resultUrl) URL.revokeObjectURL(task.resultUrl)
      task.resultBlob = result.blob
      task.resultUrl = result.previewUrl
      task.maskPreviewUrl = result.maskPreviewUrl
      task.regionLabel = result.regionLabel
      task.status = 'done'
      fileProgress.value = 100
      message.success(result.note)
    }
  } catch (e) {
    task.status = 'error'
    task.error = e instanceof Error ? e.message : '处理失败'
  }
}

async function onStartProcess() {
  const pending = tasks.value.filter((t) => t.status === 'pending' || t.status === 'error')
  if (!pending.length) {
    message.info('没有待处理文件')
    return
  }
  processing.value = true
  progressDone.value = 0
  progressTotal.value = pending.length
  let done = 0
  for (const task of pending) {
    await processOne(task)
    fileProgress.value = 0
    done += 1
    progressDone.value = done
  }
  processing.value = false
  progressPhase.value = ''

  const ok = doneCount.value
  const bad = failCount.value
  const savable = tasks.value.filter((t) => t.status === 'done' && t.resultBlob).length

  if (ok && !bad) {
    dialog.info({
      title: '去水印完成',
      content: '图片已经全部处理完成，是否保存全部？',
      positiveText: '保存全部',
      negativeText: '暂不',
      onPositiveClick: () => {
        void downloadAll()
      }
    })
  } else if (ok && bad) {
    dialog.info({
      title: '去水印完成',
      content: `完成：成功 ${ok}，失败 ${bad}。是否保存已成功的结果？`,
      positiveText: '保存全部',
      negativeText: '暂不',
      onPositiveClick: () => {
        void downloadAll()
      }
    })
  } else if (savable) {
    dialog.info({
      title: '去水印完成',
      content: `本轮无新增成功项，当前仍有 ${savable} 个可保存结果。是否保存？`,
      positiveText: '保存全部',
      negativeText: '暂不',
      onPositiveClick: () => {
        void downloadAll()
      }
    })
  } else {
    message.error(`全部失败（${bad}）`)
  }
}

function downloadExt(task: WatermarkTask) {
  if (task.kind === 'image') return 'png'
  const type = task.resultBlob?.type || ''
  if (type.includes('webm')) return 'webm'
  return 'mp4'
}

function resultFilename(task: WatermarkTask) {
  const base = task.name.replace(/\.[^.]+$/, '') || 'result'
  return `${base}-nowm.${downloadExt(task)}`
}

function downloadTask(task: WatermarkTask) {
  if (!task.resultBlob) return
  const a = document.createElement('a')
  a.href = URL.createObjectURL(task.resultBlob)
  a.download = resultFilename(task)
  a.click()
  URL.revokeObjectURL(a.href)
}

async function downloadTasksWithBrowserQueue(doneTasks: WatermarkTask[]) {
  for (let i = 0; i < doneTasks.length; i++) {
    downloadSaveLabel.value = doneTasks[i].name
    downloadTask(doneTasks[i])
    downloadSaveDone.value = i + 1
    await new Promise((r) => setTimeout(r, 280))
  }
}

async function downloadAll() {
  const doneTasks = tasks.value.filter((t) => t.status === 'done' && t.resultBlob)
  if (!doneTasks.length) {
    message.info('暂无可下载结果')
    return
  }
  if (downloadingAll.value) return

  downloadingAll.value = true
  downloadSaveDone.value = 0
  downloadSaveTotal.value = doneTasks.length
  downloadSaveLabel.value = ''
  downloadSaveFailHint.value = ''

  try {
    if (!canUseDirectoryPicker()) {
      message.info('当前浏览器不支持选文件夹，将逐个触发下载（可能需允许「多个下载」）')
      await downloadTasksWithBrowserQueue(doneTasks)
      dialog.info({
        title: '下载结果',
        content: `已触发下载（${doneTasks.length} 个文件）`,
        positiveText: '知道了'
      })
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
      message.info('当前浏览器不支持选文件夹，将逐个触发下载（可能需允许「多个下载」）')
      await downloadTasksWithBrowserQueue(doneTasks)
      dialog.info({
        title: '下载结果',
        content: `已触发下载（${doneTasks.length} 个文件）`,
        positiveText: '知道了'
      })
      return
    }

    const usedNames = new Set<string>()
    let ok = 0
    let fail = 0
    const failReasons: string[] = []

    for (let i = 0; i < doneTasks.length; i++) {
      const task = doneTasks[i]
      const filename = resultFilename(task)
      downloadSaveLabel.value = task.name
      downloadSaveFailHint.value = ''

      const result = await writeOneBlobToDirectory(
        picked.dir,
        {
          blob: task.resultBlob!,
          filename,
          label: task.name
        },
        { index: i, usedNames }
      )

      downloadSaveDone.value = i + 1
      if (result.ok) {
        ok += 1
      } else {
        fail += 1
        downloadSaveFailHint.value = `已跳过：${task.name}（${result.reason}）`
        failReasons.push(`${task.name}：${result.reason}`)
      }
    }

    if (fail === 0) {
      dialog.info({
        title: '下载结果',
        content: `已保存 ${ok} 个文件到所选文件夹`,
        positiveText: '知道了'
      })
    } else {
      dialog.warning({
        title: '下载结果',
        content: `成功 ${ok}，失败 ${fail}${failReasons.length ? `\n${failReasons.slice(0, 5).join('\n')}` : ''}`,
        positiveText: '知道了'
      })
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : '保存失败')
  } finally {
    downloadingAll.value = false
    downloadSaveDone.value = 0
    downloadSaveTotal.value = 0
    downloadSaveLabel.value = ''
    downloadSaveFailHint.value = ''
  }
}

function statusTag(task: WatermarkTask) {
  if (task.status === 'pending') return { type: 'default' as const, label: '待处理' }
  if (task.status === 'processing') return { type: 'info' as const, label: '处理中' }
  if (task.status === 'done') return { type: 'success' as const, label: '完成' }
  return { type: 'error' as const, label: '失败' }
}

function onWindowScroll() {
  showBackTop.value = window.scrollY > 360
}

function scrollToTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function scrollToProgress() {
  const el =
    (fetchingLinks.value && linkProgressPanelRef.value) ||
    (processing.value && processProgressPanelRef.value) ||
    processProgressPanelRef.value ||
    linkProgressPanelRef.value
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function bindProgressObserver(el: HTMLElement | null) {
  progressObserver?.disconnect()
  progressObserver = null
  progressPanelRef.value = el
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

function resolveActiveProgressPanel() {
  if ((fetchingLinks.value || parsingHtml.value) && linkProgressPanelRef.value) {
    return linkProgressPanelRef.value
  }
  if (processing.value && processProgressPanelRef.value) return processProgressPanelRef.value
  return processProgressPanelRef.value || linkProgressPanelRef.value
}

watch([linkProgressPanelRef, processProgressPanelRef, fetchingLinks, parsingHtml, processing], () => {
  bindProgressObserver(resolveActiveProgressPanel())
})

onMounted(() => {
  window.addEventListener('scroll', onWindowScroll, { passive: true })
  onWindowScroll()
})

onUnmounted(() => {
  window.removeEventListener('scroll', onWindowScroll)
  progressObserver?.disconnect()
  progressObserver = null
  clearAll()
})
</script>

<template>
  <div class="page">
    <main class="shell">
      <AppNav />

      <header class="hero">
        <h1 class="headline">
          {{ showAiLinkFetch ? '上传文件或粘贴 AI 聊天链接，自动识别并去除水印' : '粘贴网页源码或上传文件，自动识别并去除水印' }}
        </h1>
        <p class="sub">
          <template v-if="showAiLinkFetch">
            推荐粘贴豆包网页源码在本地提取无水印原图；也支持分享链接云端拉图，或上传图片 / zip / 短视频。一次只能选一种类型。
          </template>
          <template v-else>
            推荐粘贴豆包网页源码提取无水印原图；也可上传图片 / zip / 短视频。一次只能选一种类型。
          </template>
        </p>
      </header>

      <section class="panel">
        <div class="panel-head">
          <label class="label" for="html-source-input">粘贴网页源码（推荐 · 不经后端）</label>
          <span class="hint-inline">打开豆包 → 右键「查看网页源代码」→ Ctrl+A 复制</span>
        </div>
        <NInput
          id="html-source-input"
          v-model:value="htmlDraft"
          type="textarea"
          :autosize="{ minRows: 4, maxRows: 12 }"
          placeholder="在此粘贴完整 HTML 源码，将优先提取 image_ori_raw 无水印原图…"
          :disabled="busy"
        />
        <div class="actions">
          <NButton quaternary :disabled="busy || !htmlDraft.trim()" @click="htmlDraft = ''">清空源码</NButton>
          <NButton
            type="primary"
            size="large"
            :loading="parsingHtml"
            :disabled="busy || !hasHtmlDraft"
            @click="onParseHtmlDraft"
          >
            从源码提取原图
          </NButton>
        </div>
      </section>

      <section v-if="showAiLinkFetch" class="panel">
        <div class="panel-head">
          <label class="label" for="ai-link-input">粘贴 AI 聊天链接</label>
          <span class="hint-inline">云端拉取 · 每行一条 · 最多 {{ MAX_LINK_QUEUE }} 条 · 仅本地可用</span>
        </div>
        <NInput
          id="ai-link-input"
          v-model:value="draft"
          type="textarea"
          :autosize="{ minRows: 4, maxRows: 10 }"
          placeholder="可一次粘贴多条，例如：&#10;https://www.doubao.com/thread/xxxxx&#10;https://www.doubao.com/thread/yyyyy"
          :disabled="busy"
          @keydown="onKeydown"
        />
        <div class="actions">
          <NButton quaternary :disabled="busy || (!hasDraft && !hasLinkQueue)" @click="onClearLinks">
            清空链接
          </NButton>
          <NButton secondary :disabled="busy || !hasDraft" @click="syncQueueFromDraft">
            整理到列表
          </NButton>
          <NButton secondary :disabled="busy" @click="onPasteAndFill">从剪贴板追加</NButton>
          <NButton
            type="primary"
            size="large"
            :loading="fetchingLinks"
            :disabled="busy || (!hasLinkQueue && !hasDraft)"
            @click="onBatchFetchLinks"
          >
            {{ hasLinkQueue && linkQueue.length > 1 ? `批量拉取（${linkQueue.length}）` : '拉取图片' }}
          </NButton>
        </div>
      </section>

      <section v-if="showAiLinkFetch && hasLinkQueue" class="panel queue-panel">
        <div class="panel-head">
          <p class="label">待拉取列表（{{ linkQueue.length }}/{{ MAX_LINK_QUEUE }}）</p>
          <div class="panel-head-actions">
            <NButton
              v-if="linkFailCount > 0"
              size="tiny"
              secondary
              :disabled="busy"
              @click="copyFailedLinkTexts"
            >
              复制失败文案（{{ linkFailCount }}）
            </NButton>
            <NButton
              v-if="linkFailCount > 0"
              size="tiny"
              type="warning"
              secondary
              :disabled="busy"
              @click="retryFailedLinks"
            >
              重试失败（{{ linkFailCount }}）
            </NButton>
            <NButton size="tiny" quaternary :disabled="busy || linkQueueAtLimit" @click="addEmptyLinkRow">
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
          <div v-for="(item, index) in linkQueue" :key="item.id" class="queue-item">
            <div class="queue-row" role="row">
              <span class="col-idx">{{ index + 1 }}</span>
              <div class="col-raw">
                <NInput
                  v-model:value="item.raw"
                  type="textarea"
                  :autosize="{ minRows: 1, maxRows: 3 }"
                  placeholder="粘贴单条 AI 聊天 / 分享链接"
                  :disabled="busy"
                  size="small"
                />
                <p v-if="item.status === 'done' && item.title" class="link-group-title">
                  分组：{{ item.title }}
                </p>
              </div>
              <span class="col-status">
                <NTag v-if="item.status === 'idle'" size="small" :bordered="false">待拉取</NTag>
                <NTag v-else-if="item.status === 'fetching'" size="small" type="info" :bordered="false">
                  拉取中
                </NTag>
                <NTag v-else-if="item.status === 'done'" size="small" type="success" :bordered="false">
                  {{ item.imageCount ? `${item.imageCount} 张` : '成功' }}
                </NTag>
                <NTag v-else size="small" type="error" :bordered="false">失败</NTag>
              </span>
              <span class="col-act">
                <button
                  type="button"
                  class="link-btn"
                  :disabled="busy || linkQueue.length <= 1"
                  @click="removeLinkRow(item.id)"
                >
                  删除
                </button>
              </span>
            </div>
          </div>
        </div>
        <p v-if="linkQueue.some((i) => i.error)" class="link-errors">
          <template v-for="item in linkQueue.filter((i) => i.error)" :key="item.id">
            <span>{{ item.error }}</span>
          </template>
        </p>
      </section>

      <section v-if="fetchingLinks || parsingHtml || linkProgressTotal" ref="linkProgressPanelRef" class="panel">
        <div class="panel-head">
          <p class="label">{{ parsingHtml ? '源码提取进度' : '拉图进度' }}</p>
          <span class="hint-inline">{{ linkProgressDone }} / {{ linkProgressTotal }}</span>
        </div>
        <NProgress
          type="line"
          :percentage="linkPercent"
          :processing="fetchingLinks || parsingHtml"
          :show-indicator="true"
        />
      </section>

      <section class="panel">
        <div class="panel-head">
          <p class="label">上传文件</p>
          <span class="hint-inline">{{ modeHint }}</span>
        </div>

        <input
          ref="fileInputRef"
          class="hidden-input"
          type="file"
          :accept="acceptAttr"
          :multiple="uploadMode !== 'zip' && uploadMode !== 'video'"
          @change="onFilesSelected"
        />

        <div class="upload-zone" @click="openPicker">
          <p class="upload-title">点击选择文件</p>
          <p class="upload-desc">支持 jpg / png / webp / bmp · zip 压缩包 · mp4 / webm / mov（≤45 秒，保留音轨）</p>
        </div>

        <div class="actions">
          <NButton quaternary :disabled="busy || !hasTasks" @click="clearTasks">清空任务</NButton>
          <NButton secondary :disabled="busy" @click="openPicker">继续添加</NButton>
          <NButton
            type="primary"
            size="large"
            :loading="processing"
            :disabled="busy || !hasTasks"
            @click="onStartProcess"
          >
            开始去水印
          </NButton>
        </div>
      </section>

      <section v-if="processing || progressTotal" ref="processProgressPanelRef" class="panel">
        <div class="panel-head">
          <p class="label">处理进度</p>
          <span class="hint-inline">
            {{ progressDone }} / {{ progressTotal || tasks.length }}
            <template v-if="progressPhase"> · {{ progressPhase }}</template>
          </span>
        </div>
        <NProgress type="line" :percentage="processPercent" :show-indicator="true" />
      </section>

      <section v-if="hasTasks" class="panel">
        <div class="panel-head">
          <p class="label">任务列表（{{ tasks.length }}）</p>
          <NButton
            size="tiny"
            secondary
            :loading="downloadingAll"
            :disabled="!doneCount || downloadingAll || busy"
            @click="downloadAll"
          >
            <template v-if="downloadingAll && downloadSaveTotal">
              保存中 {{ downloadSaveDone }}/{{ downloadSaveTotal }}
            </template>
            <template v-else>下载全部结果{{ doneCount ? `（${doneCount}）` : '' }}</template>
          </NButton>
        </div>
        <p v-if="downloadingAll && downloadSaveLabel" class="download-current">
          当前：{{ downloadSaveLabel }}
        </p>
        <p v-if="downloadingAll && downloadSaveFailHint" class="download-skip">
          {{ downloadSaveFailHint }}
        </p>

        <div class="task-list">
          <article v-for="task in tasks" :key="task.id" class="task-card">
            <div class="task-head">
              <p class="task-name">{{ task.name }}</p>
              <NTag size="small" :type="statusTag(task).type">{{ statusTag(task).label }}</NTag>
            </div>
            <p v-if="task.regionLabel" class="task-meta">检测位置：{{ task.regionLabel }}</p>

            <p v-if="task.error" class="task-error">{{ task.error }}</p>

            <div v-if="task.originalUrl || task.resultUrl" class="compare-grid">
              <div v-if="task.originalUrl" class="compare-item">
                <p class="compare-label">原图（点击预览）</p>
                <NImage
                  v-if="task.kind === 'image'"
                  :src="task.originalUrl"
                  object-fit="contain"
                  class="preview-image"
                  :img-props="{ alt: '原图' }"
                />
                <video v-else :src="task.originalUrl" controls class="preview" />
              </div>
              <div v-if="task.resultUrl" class="compare-item">
                <p class="compare-label">去水印后（点这里看结果）</p>
                <NImage
                  v-if="task.kind === 'image'"
                  :src="task.resultUrl"
                  object-fit="contain"
                  class="preview-image"
                  :img-props="{ alt: '去水印后' }"
                />
                <video v-else :src="task.resultUrl" controls class="preview" />
              </div>
              <div v-if="task.maskPreviewUrl" class="compare-item">
                <p class="compare-label">检测区域（点击预览）</p>
                <NImage
                  :src="task.maskPreviewUrl"
                  object-fit="contain"
                  class="preview-image"
                  :img-props="{ alt: '水印检测区域' }"
                />
              </div>
            </div>

            <div class="task-actions">
              <NButton
                v-if="task.status === 'done'"
                size="small"
                type="primary"
                :disabled="downloadingAll"
                @click="downloadTask(task)"
              >
                下载结果
              </NButton>
            </div>
          </article>
        </div>
      </section>
    </main>

    <div class="fab-stack">
      <button
        v-show="showFloatingProgress"
        type="button"
        class="parse-progress-fab"
        :aria-label="`进度 ${floatingPercent}%，点击跳转到进度条`"
        @click="scrollToProgress"
      >
        <NProgress
          type="circle"
          :percentage="floatingPercent"
          :processing="busy"
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
@import '../styles/page-layout.css';

.hidden-input {
  display: none;
}

.upload-zone {
  border: 1px dashed rgba(45, 212, 168, 0.45);
  border-radius: 14px;
  padding: 28px 16px;
  text-align: center;
  cursor: pointer;
  background: rgba(45, 212, 168, 0.05);
  transition: border-color 0.15s, background 0.15s;
}

.upload-zone:hover {
  border-color: rgba(45, 212, 168, 0.75);
  background: rgba(45, 212, 168, 0.08);
}

.upload-title {
  margin: 0;
  font-weight: 600;
  color: var(--ink);
}

.upload-desc {
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 0.88rem;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 14px;
}

.panel-head-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.queue-table {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.queue-row {
  display: grid;
  grid-template-columns: 36px 1fr 72px 52px;
  gap: 10px;
  align-items: start;
}

.queue-head {
  color: var(--muted);
  font-size: 0.8rem;
  padding: 0 2px;
}

.col-idx {
  padding-top: 8px;
  color: var(--muted);
  font-size: 0.85rem;
}

.col-status {
  padding-top: 6px;
}

.col-act {
  padding-top: 6px;
  text-align: right;
}

.link-btn {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: 0.85rem;
  padding: 0;
}

.link-btn:hover:not(:disabled) {
  text-decoration: underline;
}

.link-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.link-errors {
  margin: 10px 0 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.82rem;
  color: var(--danger);
}

.link-group-title {
  margin: 6px 0 0;
  font-size: 0.8rem;
  color: var(--muted);
  word-break: break-all;
}

.queue-item {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.task-card {
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 14px;
  background: rgba(11, 20, 18, 0.35);
}

.task-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.task-meta {
  margin: 6px 0 0;
  font-size: 0.8rem;
  color: var(--muted);
}

.task-name {
  margin: 0;
  font-size: 0.92rem;
  color: var(--ink);
  word-break: break-all;
}

.task-error {
  margin: 8px 0 0;
  color: var(--danger);
  font-size: 0.85rem;
}

.compare-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
  margin-top: 12px;
}

.compare-label {
  margin: 0 0 6px;
  font-size: 0.8rem;
  color: var(--muted);
}

.preview {
  width: 100%;
  max-height: 280px;
  object-fit: contain;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--line);
}

.preview-image {
  width: 100%;
  display: block;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--line);
  background: rgba(0, 0, 0, 0.25);
}

.preview-image :deep(img) {
  width: 100%;
  max-height: 280px;
  object-fit: contain;
  cursor: zoom-in;
}

.task-actions {
  margin-top: 10px;
  display: flex;
  justify-content: flex-end;
}

.download-current,
.download-skip {
  margin: 0 0 10px;
  font-size: 0.82rem;
  color: var(--muted);
}

.download-skip {
  color: var(--danger);
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

@media (max-width: 640px) {
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

  .queue-row {
    grid-template-columns: 28px 1fr;
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
}
</style>
