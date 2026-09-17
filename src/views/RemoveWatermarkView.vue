<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { NButton, NImage, NProgress, NTag, useMessage } from 'naive-ui'
import AppNav from '../components/AppNav.vue'
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

const message = useMessage()

const uploadMode = ref<UploadMode | null>(null)
const tasks = ref<WatermarkTask[]>([])
const processing = ref(false)
const progressDone = ref(0)
const progressTotal = ref(0)
const progressPhase = ref('')
const fileProgress = ref(0)
const fileInputRef = ref<HTMLInputElement | null>(null)

let idSeq = 0
function nextId() {
  idSeq += 1
  return `wm-${idSeq}`
}

const hasTasks = computed(() => tasks.value.length > 0)
const doneCount = computed(() => tasks.value.filter((t) => t.status === 'done').length)
const failCount = computed(() => tasks.value.filter((t) => t.status === 'error').length)

const acceptAttr = computed(() => {
  if (uploadMode.value === 'zip') return '.zip'
  if (uploadMode.value === 'video') return '.mp4,.webm,.mov,video/*'
  if (uploadMode.value === 'images') return '.jpg,.jpeg,.png,.webp,.bmp,image/*'
  return '.jpg,.jpeg,.png,.webp,.bmp,.zip,.mp4,.webm,.mov,image/*,video/*'
})

const modeHint = computed(() => {
  if (!uploadMode.value) return '一次仅选一种类型：多张图片 / 单个 zip / 单个视频'
  if (uploadMode.value === 'images') return `已选图片模式 · 最多 ${MAX_IMAGES} 张 · 单张 ≤ ${MAX_IMAGE_BYTES / 1024 / 1024}MB`
  if (uploadMode.value === 'zip') return '已选 zip 模式 · 仅支持 1 个压缩包'
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

function addImageTask(file: File) {
  if (file.size > MAX_IMAGE_BYTES) {
    message.error(`${file.name} 超过单张大小限制`)
    return
  }
  if (!isImageName(file.name) && !file.type.startsWith('image/')) {
    message.error(`${file.name} 不是支持的图片格式`)
    return
  }
  if (tasks.value.length >= MAX_IMAGES) {
    message.warning(`最多 ${MAX_IMAGES} 张图片`)
    return
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
    for (const img of images) addImageTask(img)
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
  if (failCount.value) message.warning(`完成：成功 ${doneCount.value}，失败 ${failCount.value}`)
  else message.success(`全部处理完成（${doneCount.value}）`)
}

function downloadExt(task: WatermarkTask) {
  if (task.kind === 'image') return 'png'
  const type = task.resultBlob?.type || ''
  if (type.includes('webm')) return 'webm'
  return 'mp4'
}

function downloadTask(task: WatermarkTask) {
  if (!task.resultBlob) return
  const base = task.name.replace(/\.[^.]+$/, '')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(task.resultBlob)
  a.download = `${base}-nowm.${downloadExt(task)}`
  a.click()
  URL.revokeObjectURL(a.href)
}

function downloadAll() {
  const doneTasks = tasks.value.filter((t) => t.status === 'done' && t.resultBlob)
  if (!doneTasks.length) {
    message.info('暂无可下载结果')
    return
  }
  for (const task of doneTasks) downloadTask(task)
}

function statusTag(task: WatermarkTask) {
  if (task.status === 'pending') return { type: 'default' as const, label: '待处理' }
  if (task.status === 'processing') return { type: 'info' as const, label: '处理中' }
  if (task.status === 'done') return { type: 'success' as const, label: '完成' }
  return { type: 'error' as const, label: '失败' }
}

onUnmounted(() => clearTasks())
</script>

<template>
  <div class="page">
    <main class="shell">
      <AppNav />

      <header class="hero">
        <h1 class="headline">上传图片或短视频，自动识别并去除水印</h1>
        <p class="sub">
          全部在浏览器本地处理。图片走 Web Worker；自动识别角标文字并用周围纹理修复（非纯色遮盖）。视频首次处理会懒加载 ffmpeg。一次只能选一种类型。
        </p>
      </header>

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
          <NButton quaternary :disabled="processing || !hasTasks" @click="clearTasks">清空</NButton>
          <NButton secondary :disabled="processing" @click="openPicker">继续添加</NButton>
          <NButton type="primary" size="large" :loading="processing" :disabled="processing || !hasTasks" @click="onStartProcess">
            开始去水印
          </NButton>
        </div>
      </section>

      <section v-if="processing || progressTotal" class="panel">
        <div class="panel-head">
          <p class="label">处理进度</p>
          <span class="hint-inline">
            {{ progressDone }} / {{ progressTotal || tasks.length }}
            <template v-if="progressPhase"> · {{ progressPhase }}</template>
          </span>
        </div>
        <NProgress
          type="line"
          :percentage="
            progressTotal
              ? Math.min(
                  100,
                  Math.round(((progressDone + fileProgress / 100) / progressTotal) * 100)
                )
              : 0
          "
          :show-indicator="true"
        />
      </section>

      <section v-if="hasTasks" class="panel">
        <div class="panel-head">
          <p class="label">任务列表（{{ tasks.length }}）</p>
          <NButton size="tiny" secondary :disabled="!doneCount" @click="downloadAll">下载全部结果</NButton>
        </div>

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
              <NButton v-if="task.status === 'done'" size="small" type="primary" @click="downloadTask(task)">
                下载结果
              </NButton>
            </div>
          </article>
        </div>
      </section>
    </main>
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
</style>
