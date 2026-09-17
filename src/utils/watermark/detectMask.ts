import type { DetectResult, WatermarkBox } from './types'

interface RegionSpec {
  label: string
  xRatio: number
  yRatio: number
  wRatio: number
  hRatio: number
}

/** 常见水印位置：四角 + 底部居中条带 */
const REGIONS: RegionSpec[] = [
  { label: '右下角', xRatio: 0.62, yRatio: 0.72, wRatio: 0.38, hRatio: 0.28 },
  { label: '左下角', xRatio: 0, yRatio: 0.72, wRatio: 0.38, hRatio: 0.28 },
  { label: '右上角', xRatio: 0.62, yRatio: 0, wRatio: 0.38, hRatio: 0.28 },
  { label: '左上角', xRatio: 0, yRatio: 0, wRatio: 0.38, hRatio: 0.28 },
  { label: '底部居中', xRatio: 0.12, yRatio: 0.8, wRatio: 0.76, hRatio: 0.2 }
]

function gray(r: number, g: number, b: number) {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

function sobelEnergy(data: Uint8ClampedArray, w: number, h: number, x0: number, y0: number, rw: number, rh: number) {
  let sum = 0
  let count = 0
  for (let y = y0 + 1; y < y0 + rh - 1; y++) {
    for (let x = x0 + 1; x < x0 + rw - 1; x++) {
      const i = (y * w + x) * 4
      const g =
        -gray(data[i - 4 - w * 4], data[i - 3 - w * 4], data[i - 2 - w * 4]) +
        gray(data[i + 4 - w * 4], data[i + 5 - w * 4], data[i + 6 - w * 4]) +
        -gray(data[i - 4], data[i - 3], data[i - 2]) +
        gray(data[i + 4], data[i + 5], data[i + 6])
      sum += Math.abs(g)
      count++
    }
  }
  return count ? sum / count : 0
}

function regionVariance(data: Uint8ClampedArray, w: number, x0: number, y0: number, rw: number, rh: number) {
  let sum = 0
  let sumSq = 0
  let count = 0
  for (let y = y0; y < y0 + rh; y++) {
    for (let x = x0; x < x0 + rw; x++) {
      const i = (y * w + x) * 4
      const g = gray(data[i], data[i + 1], data[i + 2])
      sum += g
      sumSq += g * g
      count++
    }
  }
  if (!count) return 0
  const mean = sum / count
  return sumSq / count - mean * mean
}

function scoreRegion(data: Uint8ClampedArray, width: number, height: number, region: RegionSpec): number {
  const x0 = Math.floor(width * region.xRatio)
  const y0 = Math.floor(height * region.yRatio)
  const rw = Math.max(8, Math.floor(width * region.wRatio))
  const rh = Math.max(8, Math.floor(height * region.hRatio))
  const edge = sobelEnergy(data, width, height, x0, y0, rw, rh)
  const variance = regionVariance(data, width, x0, y0, rw, rh)

  const innerX = Math.min(width - rw, Math.floor(width * 0.35))
  const innerY = Math.min(height - rh, Math.floor(height * 0.35))
  const innerVar = regionVariance(data, width, innerX, innerY, rw, rh)
  const overlayHint = Math.max(0, edge - 18) * Math.max(0, variance - innerVar * 0.6)

  return overlayHint + edge * 0.35 + variance * 0.08
}

function buildMaskInRegion(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  region: RegionSpec
): Uint8Array {
  const mask = new Uint8Array(width * height)
  const x0 = Math.floor(width * region.xRatio)
  const y0 = Math.floor(height * region.yRatio)
  const rw = Math.max(8, Math.floor(width * region.wRatio))
  const rh = Math.max(8, Math.floor(height * region.hRatio))

  const local: number[] = []
  for (let y = y0; y < y0 + rh && y < height; y++) {
    for (let x = x0; x < x0 + rw && x < width; x++) {
      const i = (y * width + x) * 4
      local.push(gray(data[i], data[i + 1], data[i + 2]))
    }
  }
  local.sort((a, b) => a - b)
  const median = local[Math.floor(local.length / 2)] ?? 128

  for (let y = y0; y < y0 + rh && y < height; y++) {
    for (let x = x0; x < x0 + rw && x < width; x++) {
      const i = (y * width + x) * 4
      const g = gray(data[i], data[i + 1], data[i + 2])
      const diff = Math.abs(g - median)
      const chroma = Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2])
      if (diff > 14 && chroma < 95) {
        mask[y * width + x] = 1
      }
    }
  }

  dilateMask(mask, width, height, 2)
  return mask
}

function dilateMask(mask: Uint8Array, width: number, height: number, radius: number) {
  const copy = mask.slice()
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!copy[y * width + x]) continue
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx >= 0 && ny >= 0 && nx < width && ny < height) {
            mask[ny * width + nx] = 1
          }
        }
      }
    }
  }
}

function maskPixelCount(mask: Uint8Array) {
  let n = 0
  for (const v of mask) if (v) n++
  return n
}

/** 从掩膜求外接矩形，并略微外扩；宽高改为奇数以兼容 ffmpeg delogo */
export function maskToBox(mask: Uint8Array, width: number, height: number, pad = 6): WatermarkBox {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) {
    return {
      x: Math.floor(width * 0.7),
      y: Math.floor(height * 0.8),
      w: Math.floor(width * 0.28) | 1,
      h: Math.floor(height * 0.18) | 1
    }
  }

  let x = Math.max(0, minX - pad)
  let y = Math.max(0, minY - pad)
  let w = Math.min(width - x, maxX - minX + 1 + pad * 2)
  let h = Math.min(height - y, maxY - minY + 1 + pad * 2)
  if (w % 2 === 0) w = Math.min(width - x, w + 1)
  if (h % 2 === 0) h = Math.min(height - y, h + 1)
  if (w < 3) w = Math.min(width - x, 3)
  if (h < 3) h = Math.min(height - y, 3)
  return { x, y, w, h }
}

/** 自动检测水印区域并生成修复掩膜 */
export function detectWatermarkMask(imageData: ImageData): DetectResult {
  const { data, width, height } = imageData
  let bestRegion = REGIONS[0]
  let bestScore = -1

  for (const region of REGIONS) {
    const score = scoreRegion(data, width, height, region)
    if (score > bestScore) {
      bestScore = score
      bestRegion = region
    }
  }

  const mask = buildMaskInRegion(data, width, height, bestRegion)
  const pixels = maskPixelCount(mask)
  const areaRatio = pixels / (width * height)
  const confidence = Math.min(1, bestScore / 120) * (areaRatio > 0.0005 && areaRatio < 0.35 ? 1 : 0.35)

  if (pixels < 16 || confidence < 0.12) {
    throw new Error('未检测到明显水印区域，请换一张图或确认水印位于边角/底部')
  }

  return {
    mask,
    width,
    height,
    confidence,
    regionLabel: bestRegion.label,
    box: maskToBox(mask, width, height)
  }
}

export function maskToPreviewData(
  mask: Uint8Array,
  width: number,
  height: number
): { buffer: ArrayBuffer; width: number; height: number } {
  const out = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4
    if (mask[i]) {
      out[o] = 45
      out[o + 1] = 212
      out[o + 2] = 168
      out[o + 3] = 180
    } else {
      out[o + 3] = 40
    }
  }
  return { buffer: out.buffer, width, height }
}

export function maskToPreviewUrl(mask: Uint8Array, width: number, height: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const preview = maskToPreviewData(mask, width, height)
  ctx.putImageData(new ImageData(new Uint8ClampedArray(preview.buffer), width, height), 0, 0)
  return canvas.toDataURL('image/png')
}
