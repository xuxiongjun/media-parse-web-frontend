import type { DetectResult, WatermarkBox } from './types'

interface RegionSpec {
  label: string
  edge: 'bottom' | 'top'
  side: 'left' | 'right'
}

const REGIONS: RegionSpec[] = [
  { label: '右下角', edge: 'bottom', side: 'right' },
  { label: '左下角', edge: 'bottom', side: 'left' },
  { label: '右上角', edge: 'top', side: 'right' },
  { label: '左上角', edge: 'top', side: 'left' }
]

function gray(r: number, g: number, b: number) {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

function chromaOf(r: number, g: number, b: number) {
  return Math.max(r, g, b) - Math.min(r, g, b)
}

/** 贴角窄带：底部只取最下面约 4.5%，避免吃进主体 */
function textBandBounds(width: number, height: number, region: RegionSpec) {
  const bandH = Math.max(22, Math.floor(height * 0.045))
  const bandW = Math.max(100, Math.floor(width * 0.42))
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

/**
 * 局部高通找白字描边：
 * - 相对邻域更亮（字在底上）
 * - 低饱和（白/灰字，排除黄叶）
 * 平坦高光路面：亮度≈邻域均值 → 不会命中
 */
function collectTextStrokes(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  band: { x0: number; y0: number; x1: number; y1: number }
) {
  const stroke = new Uint8Array(width * height)
  const rad = 2
  let count = 0
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  let strengthSum = 0

  for (let y = band.y0 + rad; y < band.y1 - rad; y++) {
    for (let x = band.x0 + rad; x < band.x1 - rad; x++) {
      const i = (y * width + x) * 4
      const g = gray(data[i], data[i + 1], data[i + 2])
      const c = chromaOf(data[i], data[i + 1], data[i + 2])
      if (c >= 45) continue // 彩色（树叶等）直接排除

      let sum = 0
      let n = 0
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          if (!dx && !dy) continue
          const j = ((y + dy) * width + (x + dx)) * 4
          sum += gray(data[j], data[j + 1], data[j + 2])
          n++
        }
      }
      const local = sum / n
      const diff = g - local
      // 白字描边：明显亮于局部；且本身够亮，避免暗纹噪声
      if (diff >= 12 && g >= 140) {
        stroke[y * width + x] = 1
        count++
        strengthSum += diff
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }

  return {
    stroke,
    count,
    strengthSum,
    minX,
    minY,
    maxX,
    maxY,
    has: count >= 8 && maxX >= 0
  }
}

function scoreRegion(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  region: RegionSpec
): number {
  const band = textBandBounds(width, height, region)
  const s = collectTextStrokes(data, width, height, band)
  if (!s.has) return 0

  const bw = s.maxX - s.minX + 1
  const bh = s.maxY - s.minY + 1
  const aspect = bw / Math.max(1, bh)

  // 一行角标字：偏宽、高度小
  let shapeScore = 0
  if (bh <= height * 0.06 && aspect >= 2.2) shapeScore = 50
  else if (bh <= height * 0.08 && aspect >= 1.5) shapeScore = 25
  else shapeScore = Math.max(0, 15 - bh / 4)

  const dens = s.count / Math.max(1, bw * bh)
  const densScore = dens > 0.02 && dens < 0.55 ? 30 : dens * 20

  const avgStrength = s.strengthSum / s.count
  const strengthScore = Math.min(35, avgStrength * 1.5)

  // 贴最外沿
  const edgeY =
    region.edge === 'bottom'
      ? 1 - (band.y1 - 1 - s.maxY) / Math.max(1, band.y1 - band.y0)
      : 1 - (s.minY - band.y0) / Math.max(1, band.y1 - band.y0)
  const edgeX =
    region.side === 'right'
      ? 1 - (band.x1 - 1 - s.maxX) / Math.max(1, band.x1 - band.x0)
      : 1 - (s.minX - band.x0) / Math.max(1, band.x1 - band.x0)
  const edgeScore = edgeY * 30 + edgeX * 25

  // 豆包 / 通义等常见右下角，给强先验
  const prior =
    region.label === '右下角' ? 40 : region.edge === 'bottom' ? 15 : region.side === 'right' ? 5 : 0

  // 描边太少或铺满整带，降权
  const countScore = s.count < 20 ? s.count : Math.min(40, 20 + s.count / 30)

  return shapeScore + densScore + strengthScore + edgeScore + prior + countScore
}

function buildTextMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  region: RegionSpec
): { mask: Uint8Array; box: WatermarkBox; brightCount: number } {
  const band = textBandBounds(width, height, region)
  const s = collectTextStrokes(data, width, height, band)
  const mask = new Uint8Array(width * height)

  let box: WatermarkBox
  if (!s.has) {
    box = fallbackBox(width, height, region)
  } else {
    const padX = 8
    const padY = 5
    let x = Math.max(band.x0, s.minX - padX)
    let y = Math.max(band.y0, s.minY - padY)
    let w = Math.min(band.x1 - 1, s.maxX + padX) - x + 1
    let h = Math.min(band.y1 - 1, s.maxY + padY) - y + 1

    // 底部水印强制贴底，高度封顶（尽量贴字，少盖路面）
    const maxH = Math.max(20, Math.floor(height * 0.038))
    if (region.edge === 'bottom') {
      if (h > maxH) {
        y = height - maxH
        h = maxH
      } else {
        // 向下贴边
        const bottom = y + h
        if (bottom < height) {
          h += height - bottom
          if (h > maxH) {
            y = height - maxH
            h = maxH
          }
        }
      }
      // 右侧水印向右贴边扩展一点，避免漏字尾
      if (region.side === 'right' && x + w < width) {
        w = width - x
      }
    }

    if (w < 60) {
      if (region.side === 'right') {
        x = Math.max(band.x0, width - 140)
        w = width - x
      } else {
        w = Math.min(band.x1 - x, 140)
      }
    }

    box = { x, y, w: w | 1, h: h | 1 }
  }

  fillRect(mask, width, box)
  dilateMask(mask, width, height, 2)
  return { mask, box, brightCount: s.count }
}

function fallbackBox(width: number, height: number, region: RegionSpec): WatermarkBox {
  const h = Math.max(26, Math.floor(height * 0.04))
  const w = Math.max(120, Math.floor(width * 0.4))
  if (region.edge === 'bottom' && region.side === 'right') {
    return { x: width - w - 1, y: height - h - 1, w: w | 1, h: h | 1 }
  }
  if (region.edge === 'bottom' && region.side === 'left') {
    return { x: 1, y: height - h - 1, w: w | 1, h: h | 1 }
  }
  if (region.edge === 'top' && region.side === 'right') {
    return { x: width - w - 1, y: 1, w: w | 1, h: h | 1 }
  }
  return { x: 1, y: 1, w: w | 1, h: h | 1 }
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
      y: Math.floor(height * 0.95),
      w: Math.floor(width * 0.4) | 1,
      h: Math.floor(height * 0.045) | 1
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

  const scored = REGIONS.map((region) => ({
    region,
    score: scoreRegion(data, width, height, region)
  })).sort((a, b) => b.score - a.score)

  let best = scored[0]

  // 若右下角有明确描边信号，即使分数略低也优先（豆包水印几乎总在右下）
  const br = scored.find((s) => s.region.label === '右下角')
  if (br && br.score >= 35 && best.region.label !== '右下角') {
    // 仅当其它角不是大幅领先时，强制右下
    if (best.score < br.score + 50) best = br
  }

  // 全都弱信号：默认右下角兜底条带
  if (best.score < 30) {
    best = { region: REGIONS[0], score: 30 }
  }

  const { mask, box, brightCount } = buildTextMask(data, width, height, best.region)
  let pixels = 0
  for (const v of mask) if (v) pixels++

  if (pixels < 16) {
    throw new Error('未检测到明显水印区域，请换一张图或确认水印位于边角/底部')
  }

  return {
    mask,
    width,
    height,
    confidence: Math.min(1, best.score / 120 + brightCount / 2000),
    regionLabel: best.region.label,
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
