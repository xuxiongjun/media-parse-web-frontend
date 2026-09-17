import { detectWatermarkMask } from './detectMask'
import { inpaintImageData } from './inpaint'

const MAX_DURATION_SEC = 20
const TARGET_FPS = 12

export interface ProcessVideoResult {
  blob: Blob
  previewUrl: string
  regionLabel: string
  confidence: number
  note: string
}

function waitSeek(video: HTMLVideoElement, time: number) {
  return new Promise<void>((resolve, reject) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked)
      resolve()
    }
    const onError = () => {
      video.removeEventListener('error', onError)
      reject(new Error('视频帧读取失败'))
    }
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('error', onError)
    video.currentTime = time
  })
}

export async function processVideoFile(
  file: File,
  onProgress?: (percent: number) => void
): Promise<ProcessVideoResult> {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.src = url
  video.muted = true
  video.playsInline = true
  video.crossOrigin = 'anonymous'

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve()
    video.onerror = () => reject(new Error('视频加载失败'))
  })

  if (video.duration > MAX_DURATION_SEC) {
    URL.revokeObjectURL(url)
    throw new Error(`免费方案暂支持 ${MAX_DURATION_SEC} 秒以内的短视频`)
  }

  const width = video.videoWidth
  const height = video.videoHeight
  if (!width || !height) {
    URL.revokeObjectURL(url)
    throw new Error('无法读取视频尺寸')
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    URL.revokeObjectURL(url)
    throw new Error('Canvas 不可用')
  }

  video.currentTime = 0
  await waitSeek(video, 0)
  ctx.drawImage(video, 0, 0)
  const firstFrame = ctx.getImageData(0, 0, width, height)
  const detected = detectWatermarkMask(firstFrame)

  const stream = canvas.captureStream(TARGET_FPS)
  const recorder = new MediaRecorder(stream, { mimeType: pickMimeType() })
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data)
  }

  const recorded = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }))
    recorder.onerror = () => reject(new Error('视频编码失败'))
  })

  recorder.start(200)
  const frameCount = Math.max(1, Math.floor(video.duration * TARGET_FPS))

  for (let i = 0; i < frameCount; i++) {
    const t = Math.min(video.duration - 0.001, i / TARGET_FPS)
    await waitSeek(video, t)
    ctx.drawImage(video, 0, 0)
    const frame = ctx.getImageData(0, 0, width, height)
    const repaired = inpaintImageData(frame, detected.mask, 8)
    ctx.putImageData(repaired, 0, 0)
    onProgress?.(Math.round(((i + 1) / frameCount) * 100))
    await sleep(1000 / TARGET_FPS)
  }

  recorder.stop()
  const blob = await recorded
  URL.revokeObjectURL(url)

  const previewUrl = URL.createObjectURL(blob)
  return {
    blob,
    previewUrl,
    regionLabel: detected.regionLabel,
    confidence: detected.confidence,
    note: '免费方案在浏览器内重编码，输出 WebM 且不含原声轨'
  }
}

function pickMimeType() {
  if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) return 'video/webm;codecs=vp9'
  if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) return 'video/webm;codecs=vp8'
  return 'video/webm'
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
