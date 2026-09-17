import type { DetectResult, WatermarkBox } from './types'

interface RegionSpec {
  label: string
  xRatio: number
  yRatio: number
  wRatio: number
  hRatio: number
  edge: 'bottom' | 'top'
  side: 'left' | 'right'
}

const REGIONS: RegionSpec[] = [
  { label: '右下角', xRatio: 0.55, yRatio: 0.9, wRatio: 0.45, hRatio: 0.1, edge: 'bottom', side: 'right' },
  { label: '左下角', xRatio: 0, yRatio: 0.9, wRatio: 0.45, hRatio: 0.1, edge: 'bottom', side: 'left' },
  { label: '右上角', xRatio: 0.55, yRatio: 0, wRatio: 0.45, hRatio: 0.1, edge: 'top', side: 'right' },
  { label: '左上角', xRatio: 0, yRatio: 0, wRatio: 0.45, hRatio: 0.1, edge: 'top', side: 'left' }
]

function gray(r: number, g: number, b: number) {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/** 只搜贴边窄带，专门找角标白字 */
function textBandBounds(width: number, height: number, region: RegionSpec) {
  const bandH = Math.max(26, Math.floor(height * 0.06))
  const bandW = Math.max(80, Math.floor(width * 0.45))
  if (region.edge === 'bottom' && region.side === 'right') {
    return { x0: width - bandW, y0: height - bandH, x1: width, y1: height }
  }
  if (region.edge === 'bottom' && region.side === 'left') {
    return { x0: 0, y0: height - bandH, x1: bandW, y1: height }
  }
  if (region.edge === 'top' && region.side === 'right') {
    return { x0: width - bandW, y0: 0, x1: width, y1: bandH }
  }
  return { x0: 0, y0: 0, x1: bandW, y1: bandH }
}

/** 是否像水印白字：高对比亮色、低饱和 */
function isWatermarkInk(
  data: Uint8ClampedArray,
  i: number,
  floorLevel: number
): { hit: boolean; strength: number } {
  const g = gray(data[i], data[i + 1], data[i + 2])
  const chroma =
    Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2])
  // 「豆包AI」白字约 190~210，地面约 110~130 → 差值常 >40
  const strongWhite = g >= Math.max(165, floorLevel + 35) && chroma < 70
  const mildWhite = g >= floorLevel + 28 && chroma < 55 && g >= 150
  if (strongWhite) return { hit: true, strength: g - floorLevel }
  if (mildWhite) return { hit: true, strength: (g - floorLevel) * 0.7 }
  return { hit: false, strength: 0 }
}

function scoreRegion(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  region: RegionSpec
): number {
  const band = textBandBounds(width, height, region)
  const samples: number[] = []
  for (let y = band.y0; y < band.y1; y++) {
    for (let x = band.x0; x < band.x1; x += 2) {
      const i = (y * width + x) * 4
      samples.push(gray(data[i], data[i + 1], data[i + 2]))
    }
  }
  if (samples.length < 16) return 0
  samples.sort((a, b) => a - b)
  // 用更低分位当地面，避免白字抬高阈值
  const floorLevel = samples[Math.floor(samples.length * 0.3)] ?? 128

  let ink = 0
  let total = 0
  let strengthSum = 0
  let minX = width
  let maxX = -1
  let minY = height
  let maxY = -1

  for (let y = band.y0; y < band.y1; y++) {
    for (let x = band.x0; x < band.x1; x++) {
      const i = (y * width + x) * 4
      total++
      const { hit, strength } = isWatermarkInk(data, i, floorLevel)
      if (!hit) continue
      ink++
      strengthSum += strength
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (ink < 12) return ink * 0.5

  const ratio = ink / total
  // 真正角标白字占比通常很小（0.5%~8%），太大说明是大面积高光误检
  let ratioScore = 0
  if (ratio >= 0.004 && ratio <= 0.1) ratioScore = 60
  else if (ratio > 0.1 && ratio <= 0.18) ratioScore = 25
  else ratioScore = Math.max(0, 15 - ratio * 40)

  const avgStrength = strengthSum / ink
  const strengthScore = Math.min(45, avgStrength)

  // 文字应贴近角落外沿
  const edgeY =
    region.edge === 'bottom'
      ? 1 - (band.y1 - 1 - maxY) / Math.max(1, band.y1 - band.y0)
      : 1 - (minY - band.y0) / Math.max(1, band.y1 - band.y0)
  const edgeX =
    region.side === 'right'
      ? 1 - (band.x1 - 1 - maxX) / Math.max(1, band.x1 - band.x0)
      : 1 - (minX - band.x0) / Math.max(1, band.x1 - band.x0)
  const edgeScore = edgeY * 25 + edgeX * 20

  // 横向长条更像一行字
  const bw = Math.max(1, maxX - minX + 1)
  const bh = Math.max(1, maxY - minY + 1)
  const aspectScore = Math.min(20, (bw / bh) * 4)

  // AI 平台水印常见右下角，给稳定加权
  const brBias = region.label === '右下角' ? 18 : region.edge === 'bottom' ? 8 : 0

  return ratioScore + strengthScore + edgeScore + aspectScore + brBias
}

function buildBrightTextMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  region: RegionSpec
): { mask: Uint8Array; box: WatermarkBox; brightCount: number } {
  const band = textBandBounds(width, height, region)
  const stroke = new Uint8Array(width * height)

  const samples: number[] = []
  for (let y = band.y0; y < band.y1; y++) {
    for (let x = band.x0; x < band.x1; x++) {
      const i = (y * width + x) * 4
      samples.push(gray(data[i], data[i + 1], data[i + 2]))
    }
  }
  samples.sort((a, b) => a - b)
  const floorLevel = samples[Math.floor(samples.length * 0.3)] ?? 128

  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  let brightCount = 0

  for (let y = band.y0; y < band.y1; y++) {
    for (let x = band.x0; x < band.x1; x++) {
      const i = (y * width + x) * 4
      const { hit } = isWatermarkInk(data, i, floorLevel)
      if (!hit) continue
      stroke[y * width + x] = 1
      brightCount++
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }

  const mask = new Uint8Array(width * height)

  if (maxX < 0 || brightCount < 10) {
    const box = fallbackBox(width, height, region)
    fillRect(mask, width, box)
    return { mask, box, brightCount: box.w * box.h }
  }

  const padX = 12
  const padY = 8
  let box: WatermarkBox = {
    x: Math.max(band.x0, minX - padX),
    y: Math.max(band.y0, minY - padY),
    w: Math.min(band.x1 - 1, maxX + padX) - Math.max(band.x0, minX - padX) + 1,
    h: Math.min(band.y1 - 1, maxY + padY) - Math.max(band.y0, minY - padY) + 1
  }

  // 高度封顶，避免吃靴子；底部水印强制贴底
  const maxH = Math.max(28, Math.floor(height * 0.055))
  if (box.h > maxH) {
    if (region.edge === 'bottom') box.y = box.y + box.h - maxH
    box.h = maxH
  }
  if (region.edge === 'bottom') {
    box.h = Math.min(height - box.y, Math.max(box.h, maxY - box.y + 6))
    if (box.y + box.h < height) {
      box.h = height - box.y
    }
    // 再限制一次最大高度
    if (box.h > maxH) {
      box.y = height - maxH
      box.h = maxH
    }
  }

  // 宽度不够时向角外侧扩展，确保整行字在内
  if (box.w < 70) {
    if (region.side === 'right') {
      box.x = Math.max(band.x0, band.x1 - 120)
      box.w = band.x1 - box.x
    } else {
      box.w = Math.min(band.x1 - box.x, 120)
    }
  }

  fillRect(mask, width, box)
  dilateMask(mask, width, height, 3)

  return { mask, box, brightCount }
}

function fallbackBox(width: number, height: number, region: RegionSpec): WatermarkBox {
  const h = Math.max(26, Math.floor(height * 0.045))
  const w = Math.max(110, Math.floor(width * 0.38))
  if (region.edge === 'bottom' && region.side === 'right') {
    return { x: width - w - 2, y: height - h - 1, w: w | 1, h: h | 1 }
  }
  if (region.edge === 'bottom' && region.side === 'left') {
    return { x: 2, y: height - h - 1, w: w | 1, h: h | 1 }
  }
  if (region.edge === 'top' && region.side === 'right') {
    return { x: width - w - 2, y: 1, w: w | 1, h: h | 1 }
  }
  return { x: 2, y: 1, w: w | 1, h: h | 1 }
}

function fillRect(mask: Uint8Array, width: number, box: WatermarkBox) {
  const height = (mask.length / width) | 0
  const x1 = Math.min(width - 1, box.x + box.w - 1)
  const y1 = Math.min(height - 1, box.y + box.h - 1)
  for (let y = Math.max(0, box.y); y <= y1; y++) {
    for (let x = Math.max(0, box.x); x <= x1; x++) {
      mask[y * width + x] = 1
    }
  }
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
          if (nx >= 0 && ny >= 0 && nx < width && ny < height) mask[ny * width + nx] = 1
        }
      }
    }
  }
}

export function maskToBox(mask: Uint8Array, width: number, height: number, pad = 2): WatermarkBox {
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
      x: Math.floor(width * 0.58),
      y: Math.floor(height * 0.94),
      w: Math.floor(width * 0.4) | 1,
      h: Math.floor(height * 0.05) | 1
    }
  }
  let x = Math.max(0, minX - pad)
  let y = Math.max(0, minY - pad)
  let w = Math.min(width - x, maxX - minX + 1 + pad * 2)
  let h = Math.min(height - y, maxY - minY + 1 + pad * 2)
  if (w % 2 === 0) w = Math.min(width - x, w + 1)
  if (h % 2 === 0) h = Math.min(height - y, h + 1)
  return { x, y, w, h }
}

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

  // 若最高分仍很低，默认右下角（最常见）
  if (bestScore < 40) {
    bestRegion = REGIONS[0]
  }

  const { mask, box, brightCount } = buildBrightTextMask(data, width, height, bestRegion)
  let pixels = 0
  for (const v of mask) if (v) pixels++

  if (pixels < 20) {
    throw new Error('未检测到明显水印区域，请换一张图或确认水印位于边角/底部')
  }

  return {
    mask,
    width,
    height,
    confidence: Math.min(1, bestScore / 100 + brightCount / 3000),
    regionLabel: bestRegion.label,
    box
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
      out[o + 3] = 210
    } else {
      out[o + 3] = 36
    }
  }
  return { buffer: out.buffer.slice(0), width, height }
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
