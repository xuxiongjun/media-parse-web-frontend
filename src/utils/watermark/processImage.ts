import type { ImageWorkerRequest, ImageWorkerResponse } from './workers/imageWorker'

export interface ProcessImageResult {
  blob: Blob
  previewUrl: string
  maskPreviewUrl: string
  regionLabel: string
  confidence: number
}

type Pending = {
  resolve: (value: ImageWorkerResponse) => void
  reject: (reason?: unknown) => void
}

let worker: Worker | null = null
let seq = 0
const pending = new Map<string, Pending>()

function resetWorker() {
  if (worker) {
    worker.terminate()
    worker = null
  }
  pending.clear()
}

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./workers/imageWorker.ts', import.meta.url), {
      type: 'module',
      name: 'watermark-image-v6-texture'
    })
    worker.onmessage = (event: MessageEvent<ImageWorkerResponse>) => {
      const job = pending.get(event.data.id)
      if (!job) return
      pending.delete(event.data.id)
      job.resolve(event.data)
    }
    worker.onerror = (err) => {
      for (const [, job] of pending) job.reject(err)
      resetWorker()
    }
  }
  return worker
}

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片加载失败'))
    }
    img.src = url
  })
}

function bufferToObjectUrl(buffer: ArrayBuffer, width: number, height: number, type = 'image/png') {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 不可用')
  // 必须用精确长度的视图，避免 buffer 带多余字节
  const pixels = new Uint8ClampedArray(buffer, 0, width * height * 4)
  ctx.putImageData(new ImageData(pixels.slice(), width, height), 0, 0)
  return new Promise<{ blob: Blob; url: string }>((resolve, reject) => {
    canvas.toBlob((b) => {
      if (!b) {
        reject(new Error('导出失败'))
        return
      }
      resolve({ blob: b, url: URL.createObjectURL(b) })
    }, type)
  })
}

function runInWorker(imageData: ImageData): Promise<ImageWorkerResponse> {
  const id = `img-${++seq}`
  const w = getWorker()
  // 精确拷贝像素，避免 ImageData.buffer 偏移/多余长度导致 Worker 处理错图
  const pixels = new Uint8ClampedArray(imageData.data)
  const buffer = pixels.buffer
  const request: ImageWorkerRequest = {
    id,
    width: imageData.width,
    height: imageData.height,
    buffer
  }

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage(request, [buffer])
  })
}

/** 主线程解码，Worker 检测+邻色回填 */
export async function processImageFile(file: File): Promise<ProcessImageResult> {
  // 每次处理前重建 Worker，避免开发态旧脚本缓存
  resetWorker()

  const img = await loadImageFromFile(file)
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas 不可用')
  ctx.drawImage(img, 0, 0)
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)

  const response = await runInWorker(imageData)
  if (!response.ok) throw new Error(response.error)

  const result = await bufferToObjectUrl(response.resultBuffer, response.width, response.height)
  const mask = await bufferToObjectUrl(response.maskPreviewBuffer, response.width, response.height)

  return {
    blob: result.blob,
    previewUrl: result.url,
    maskPreviewUrl: mask.url,
    regionLabel: response.regionLabel,
    confidence: response.confidence
  }
}
