import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
import { detectWatermarkMask, maskToPreviewUrl } from './detectMask'
import type { WatermarkBox } from './types'

const MAX_DURATION_SEC = 45

export interface ProcessVideoResult {
  blob: Blob
  previewUrl: string
  maskPreviewUrl: string | null
  regionLabel: string
  confidence: number
  note: string
}

type LoadProgress = (phase: string, percent: number) => void

let ffmpegInstance: FFmpeg | null = null
let ffmpegLoading: Promise<FFmpeg> | null = null

/**
 * 懒加载：首次处理视频时才下载 ffmpeg core（约 25–32MB），
 * 不进入「媒体去水印」页、不处理视频时不会占用首屏流量。
 */
export async function loadFFmpeg(onProgress?: LoadProgress): Promise<FFmpeg> {
  if (ffmpegInstance) return ffmpegInstance
  if (ffmpegLoading) return ffmpegLoading

  ffmpegLoading = (async () => {
    onProgress?.('下载视频处理引擎', 5)
    const ffmpeg = new FFmpeg()
    ffmpeg.on('log', () => {})
    const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm'
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm')
    })
    onProgress?.('引擎就绪', 20)
    ffmpegInstance = ffmpeg
    return ffmpeg
  })().catch((err) => {
    ffmpegLoading = null
    throw err
  })

  return ffmpegLoading
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

async function detectFromFirstFrame(file: File): Promise<{
  box: WatermarkBox
  regionLabel: string
  confidence: number
  maskPreviewUrl: string
  duration: number
}> {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.src = url
  video.muted = true
  video.playsInline = true
  video.preload = 'metadata'

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('视频加载失败'))
    })

    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error('无法读取视频时长')
    }
    if (video.duration > MAX_DURATION_SEC) {
      throw new Error(`免费方案暂支持 ${MAX_DURATION_SEC} 秒以内的短视频`)
    }

    await waitSeek(video, Math.min(0.1, video.duration / 2))
    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height) throw new Error('无法读取视频尺寸')

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 不可用')
    ctx.drawImage(video, 0, 0)
    const frame = ctx.getImageData(0, 0, width, height)
    const detected = detectWatermarkMask(frame)

    return {
      box: detected.box,
      regionLabel: detected.regionLabel,
      confidence: detected.confidence,
      maskPreviewUrl: maskToPreviewUrl(detected.mask, width, height),
      duration: video.duration
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

function outputNameFor(file: File) {
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.webm')) return 'output.webm'
  if (lower.endsWith('.mov')) return 'output.mp4'
  return 'output.mp4'
}

function inputNameFor(file: File) {
  const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '.mp4'
  return `input${ext.toLowerCase()}`
}

/**
 * 使用 ffmpeg delogo 去水印，并 -c:a copy 保留原声轨。
 * ffmpeg.wasm 在独立线程中运行，主线程通过 progress 回调更新 UI。
 */
export async function processVideoFile(
  file: File,
  onProgress?: (percent: number, phase?: string) => void
): Promise<ProcessVideoResult> {
  onProgress?.(2, '识别水印区域')
  const detected = await detectFromFirstFrame(file)
  const { box } = detected

  const ffmpeg = await loadFFmpeg((phase, p) => onProgress?.(p, phase))
  const inputName = inputNameFor(file)
  const outputName = outputNameFor(file)

  const onFfmpegProgress = ({ progress }: { progress: number }) => {
    const pct = Math.min(99, Math.max(25, Math.round(25 + progress * 70)))
    onProgress?.(pct, '去除水印并保留音轨')
  }
  ffmpeg.on('progress', onFfmpegProgress)

  try {
    onProgress?.(22, '写入视频数据')
    await ffmpeg.writeFile(inputName, await fetchFile(file))

    const filter = `delogo=x=${box.x}:y=${box.y}:w=${box.w}:h=${box.h}:show=0`
    onProgress?.(25, '去除水印并保留音轨')

    // 视频重编码（delogo 必须），音轨尽量 copy；无音轨时忽略音频错误
    try {
      await ffmpeg.exec([
        '-i',
        inputName,
        '-vf',
        filter,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '23',
        '-c:a',
        'copy',
        '-movflags',
        '+faststart',
        outputName
      ])
    } catch {
      await ffmpeg.exec([
        '-i',
        inputName,
        '-vf',
        filter,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '23',
        '-an',
        '-movflags',
        '+faststart',
        outputName
      ])
    }

    const data = await ffmpeg.readFile(outputName)
    const raw = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data))
    const bytes = new Uint8Array(raw.byteLength)
    bytes.set(raw)
    const mime = outputName.endsWith('.webm') ? 'video/webm' : 'video/mp4'
    const blob = new Blob([bytes], { type: mime })

    try {
      await ffmpeg.deleteFile(inputName)
      await ffmpeg.deleteFile(outputName)
    } catch {
      /* ignore cleanup errors */
    }

    onProgress?.(100, '完成')
    return {
      blob,
      previewUrl: URL.createObjectURL(blob),
      maskPreviewUrl: detected.maskPreviewUrl,
      regionLabel: detected.regionLabel,
      confidence: detected.confidence,
      note: '已保留原声轨（ffmpeg 本地处理）'
    }
  } finally {
    ffmpeg.off('progress', onFfmpegProgress)
  }
}
