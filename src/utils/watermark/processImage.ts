import { detectWatermarkMask, maskToPreviewUrl } from './detectMask'
import { inpaintImageData } from './inpaint'

export interface ProcessImageResult {
  blob: Blob
  previewUrl: string
  maskPreviewUrl: string
  regionLabel: string
  confidence: number
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

export async function processImageFile(file: File): Promise<ProcessImageResult> {
  const img = await loadImageFromFile(file)
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 不可用')

  ctx.drawImage(img, 0, 0)
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const detected = detectWatermarkMask(imageData)
  const repaired = inpaintImageData(imageData, detected.mask)
  ctx.putImageData(repaired, 0, 0)

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('导出失败'))), 'image/png')
  })

  return {
    blob,
    previewUrl: canvas.toDataURL('image/png'),
    maskPreviewUrl: maskToPreviewUrl(detected.mask, detected.width, detected.height),
    regionLabel: detected.regionLabel,
    confidence: detected.confidence
  }
}
