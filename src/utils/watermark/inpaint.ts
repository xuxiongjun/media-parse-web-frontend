/**
 * 用水印旁边的色号回填（用户方案）：
 * 1. 采集掩膜外侧邻域像素颜色
 * 2. 每个掩膜像素用最近邻色 / 边界均色填充
 * 3. 边缘轻微羽化，避免硬边
 */
export function inpaintImageData(imageData: ImageData, mask: Uint8Array): ImageData {
  const { width, height, data } = imageData
  const out = new Uint8ClampedArray(data)

  let maskCount = 0
  for (const v of mask) if (v) maskCount++
  if (!maskCount) return new ImageData(out, width, height)

  const border = collectBorderSamples(data, mask, width, height)
  if (!border.length) {
    // 极端情况：整图被掩——用全局均值
    let r = 0
    let g = 0
    let b = 0
    let n = 0
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]
      g += data[i + 1]
      b += data[i + 2]
      n++
    }
    const rr = Math.round(r / Math.max(1, n))
    const gg = Math.round(g / Math.max(1, n))
    const bb = Math.round(b / Math.max(1, n))
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue
      const o = i * 4
      out[o] = rr
      out[o + 1] = gg
      out[o + 2] = bb
    }
    return new ImageData(out, width, height)
  }

  // 边界均色（平坦地面时最自然）
  let ar = 0
  let ag = 0
  let ab = 0
  for (const s of border) {
    ar += s.r
    ag += s.g
    ab += s.b
  }
  const avgR = Math.round(ar / border.length)
  const avgG = Math.round(ag / border.length)
  const avgB = Math.round(ab / border.length)

  // 逐像素：近邻色 70% + 均色 30%，既贴边又整体统一
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (!mask[idx]) continue

      const nearest = nearestBorderColor(border, x, y)
      const o = idx * 4
      out[o] = Math.round(nearest.r * 0.7 + avgR * 0.3)
      out[o + 1] = Math.round(nearest.g * 0.7 + avgG * 0.3)
      out[o + 2] = Math.round(nearest.b * 0.7 + avgB * 0.3)
    }
  }

  // 再扫一遍：掩膜内仍明显偏亮的残留字，强制用均色盖掉
  const avgGray = 0.299 * avgR + 0.587 * avgG + 0.114 * avgB
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    const o = i * 4
    const g = 0.299 * out[o] + 0.587 * out[o + 1] + 0.114 * out[o + 2]
    if (g > avgGray + 14) {
      out[o] = avgR
      out[o + 1] = avgG
      out[o + 2] = avgB
    }
  }

  softBlurMasked(out, mask, width, height)
  return new ImageData(out, width, height)
}

function collectBorderSamples(
  data: Uint8ClampedArray,
  mask: Uint8Array,
  width: number,
  height: number
) {
  const raw: { x: number; y: number; r: number; g: number; b: number; gray: number }[] = []
  const seen = new Set<number>()

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (mask[idx]) continue

      let nearMask = false
      for (let dy = -4; dy <= 4 && !nearMask; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          if (mask[ny * width + nx]) {
            nearMask = true
            break
          }
        }
      }
      if (!nearMask || seen.has(idx)) continue
      seen.add(idx)

      const o = idx * 4
      raw.push({
        x,
        y,
        r: data[o],
        g: data[o + 1],
        b: data[o + 2],
        gray: 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]
      })
    }
  }

  if (raw.length < 8) {
    return raw.map(({ x, y, r, g, b }) => ({ x, y, r, g, b }))
  }

  const grays = raw.map((s) => s.gray).sort((a, b) => a - b)
  const cut = grays[Math.floor(grays.length * 0.8)]
  return raw
    .filter((s) => s.gray <= cut)
    .map(({ x, y, r, g, b }) => ({ x, y, r, g, b }))
}

function nearestBorderColor(
  border: { x: number; y: number; r: number; g: number; b: number }[],
  x: number,
  y: number
) {
  let best = Infinity
  let r = border[0].r
  let g = border[0].g
  let b = border[0].b
  for (const s of border) {
    const d = (s.x - x) * (s.x - x) + (s.y - y) * (s.y - y)
    if (d < best) {
      best = d
      r = s.r
      g = s.g
      b = s.b
    }
  }
  return { r, g, b }
}

function softBlurMasked(out: Uint8ClampedArray, mask: Uint8Array, width: number, height: number) {
  const copy = out.slice()
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x
      if (!mask[idx]) continue
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const o = ((y + dy) * width + (x + dx)) * 4
          r += copy[o]
          g += copy[o + 1]
          b += copy[o + 2]
          n++
        }
      }
      const o = idx * 4
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
    }
  }
}
