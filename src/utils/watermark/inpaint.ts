/**
 * 纹理感知修复（避免纯色色块）：
 * 1. 从掩膜正上方克隆路面纹理（保留颗粒与光影）
 * 2. 左侧有已知像素时混合横向采样
 * 3. 边界大范围羽化，消除硬矩形接缝
 */
export function inpaintImageData(imageData: ImageData, mask: Uint8Array): ImageData {
  const { width, height, data } = imageData
  const out = new Uint8ClampedArray(data)

  let maskCount = 0
  for (const v of mask) if (v) maskCount++
  if (!maskCount) return new ImageData(out, width, height)

  const span = estimateSpan(mask, width, height)
  const filled = new Uint8Array(mask.length)

  // —— 1) 上方纹理带克隆 ——
  cloneTextureFromAbove(out, data, mask, filled, width, height, span)

  // —— 2) 仍未填的用邻域扩散 ——
  diffuseRemain(out, mask, filled, width, height)

  // —— 3) 宽羽化接缝 ——
  featherSeam(out, data, mask, width, height, 10)

  // —— 4) 接缝处轻模糊，内部保留纹理 ——
  blurSeamOnly(out, mask, width, height, 6)

  return new ImageData(out, width, height)
}

function estimateSpan(mask: Uint8Array, width: number, height: number) {
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
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 1, h: 1 }
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    w: maxX - minX + 1,
    h: maxY - minY + 1
  }
}

function cloneTextureFromAbove(
  out: Uint8ClampedArray,
  src: Uint8ClampedArray,
  mask: Uint8Array,
  filled: Uint8Array,
  width: number,
  height: number,
  span: { minX: number; minY: number; maxX: number; maxY: number; w: number; h: number }
) {
  // 取掩膜上方足够高的纹理带（至少盖住掩膜高度）
  const need = Math.max(span.h + 6, Math.min(span.minY, Math.floor(span.h * 1.8) + 8))
  if (need < 2 || span.minY < 2) return

  const srcY1 = span.minY - 1
  const srcY0 = Math.max(0, srcY1 - need + 1)
  const srcSpan = srcY1 - srcY0 + 1
  if (srcSpan < 2) return

  for (let y = span.minY; y <= span.maxY; y++) {
    for (let x = span.minX; x <= span.maxX; x++) {
      const idx = y * width + x
      if (!mask[idx]) continue

      // 纵向：循环映射到上方纹理带，保留横向颗粒
      const row = (y - span.minY) % srcSpan
      let sy = srcY1 - row
      let sx = x

      // 若正上方该列不可用，左右偏移找已知像素
      if (sy < 0 || mask[sy * width + sx]) {
        let found = false
        for (let dy = 1; dy <= need + 4 && !found; dy++) {
          const ty = span.minY - dy
          if (ty < 0) break
          if (!mask[ty * width + x]) {
            sy = ty
            sx = x
            found = true
          }
        }
        if (!found) {
          for (let dx = 1; dx <= 16 && !found; dx++) {
            for (const tx of [x - dx, x + dx]) {
              if (tx < span.minX - 8 || tx > span.maxX + 8) continue
              if (tx < 0 || tx >= width) continue
              const ty = Math.max(0, span.minY - 3)
              if (!mask[ty * width + tx]) {
                sy = ty
                sx = tx
                found = true
                break
              }
            }
          }
        }
        if (!found) continue
      }

      // 横向辅助：掩膜左侧同排已知路面（减轻竖条感）
      let r = src[sy * width * 4 + sx * 4]
      let g = src[sy * width * 4 + sx * 4 + 1]
      let b = src[sy * width * 4 + sx * 4 + 2]

      const leftX = span.minX - 1
      if (leftX >= 0 && !mask[y * width + leftX]) {
        // 取左侧 1~4 像素均值
        let lr = 0
        let lg = 0
        let lb = 0
        let ln = 0
        for (let dx = 1; dx <= 4; dx++) {
          const lx = span.minX - dx
          if (lx < 0 || mask[y * width + lx]) continue
          const o = (y * width + lx) * 4
          lr += src[o]
          lg += src[o + 1]
          lb += src[o + 2]
          ln++
        }
        if (ln) {
          // 越靠掩膜左缘，横向权重越高
          const edgeT = Math.max(0, 1 - (x - span.minX) / Math.max(8, span.w * 0.25))
          const tw = 0.35 * edgeT
          r = r * (1 - tw) + (lr / ln) * tw
          g = g * (1 - tw) + (lg / ln) * tw
          b = b * (1 - tw) + (lb / ln) * tw
        }
      }

      // 混入上方邻域小抖动，避免完全周期性条纹
      const jitterY = sy - (((x * 3 + y * 5) % 5) - 2)
      if (jitterY >= srcY0 && jitterY <= srcY1 && !mask[jitterY * width + sx]) {
        const jo = (jitterY * width + sx) * 4
        r = r * 0.82 + src[jo] * 0.18
        g = g * 0.82 + src[jo + 1] * 0.18
        b = b * 0.82 + src[jo + 2] * 0.18
      }

      const o = idx * 4
      out[o] = clamp(Math.round(r))
      out[o + 1] = clamp(Math.round(g))
      out[o + 2] = clamp(Math.round(b))
      filled[idx] = 1
    }
  }
}

function diffuseRemain(
  out: Uint8ClampedArray,
  mask: Uint8Array,
  filled: Uint8Array,
  width: number,
  height: number
) {
  for (let pass = 0; pass < 40; pass++) {
    let changed = false
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x
        if (!mask[idx] || filled[idx]) continue
        let r = 0
        let g = 0
        let b = 0
        let n = 0
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (!dx && !dy) continue
            const nx = x + dx
            const ny = y + dy
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
            const ni = ny * width + nx
            if (mask[ni] && !filled[ni]) continue
            const o = ni * 4
            r += out[o]
            g += out[o + 1]
            b += out[o + 2]
            n++
          }
        }
        if (!n) continue
        const o = idx * 4
        out[o] = Math.round(r / n)
        out[o + 1] = Math.round(g / n)
        out[o + 2] = Math.round(b / n)
        filled[idx] = 1
        changed = true
      }
    }
    if (!changed) break
  }
}

/** 距掩膜外缘的距离（曼哈顿，截断） */
function distToOutside(mask: Uint8Array, width: number, height: number, maxD: number) {
  const dist = new Uint16Array(width * height)
  dist.fill(maxD + 1)
  const q: number[] = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (!mask[idx]) {
        dist[idx] = 0
        continue
      }
      // 与外部相邻的掩膜像素作为边界
      let border = false
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1]
      ] as const) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height || !mask[ny * width + nx]) {
          border = true
          break
        }
      }
      if (border) {
        dist[idx] = 1
        q.push(idx)
      }
    }
  }

  let qi = 0
  while (qi < q.length) {
    const cur = q[qi++]
    const d = dist[cur]
    if (d >= maxD) continue
    const x = cur % width
    const y = (cur / width) | 0
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ] as const) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      const ni = ny * width + nx
      if (!mask[ni]) continue
      if (dist[ni] > d + 1) {
        dist[ni] = d + 1
        q.push(ni)
      }
    }
  }
  return dist
}

function featherSeam(
  out: Uint8ClampedArray,
  original: Uint8ClampedArray,
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number
) {
  const dist = distToOutside(mask, width, height, radius)
  const copy = out.slice()

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (!mask[idx]) continue
      const d = dist[idx]
      if (d > radius) continue

      // 采集外侧原图像素
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const ni = ny * width + nx
          if (mask[ni]) continue
          const o = ni * 4
          r += original[o]
          g += original[o + 1]
          b += original[o + 2]
          n++
        }
      }
      if (!n) continue

      // d=1 强混外侧，d=radius 几乎保留克隆纹理
      const t = 1 - d / (radius + 0.01)
      const mix = t * t * 0.85
      const o = idx * 4
      out[o] = Math.round(copy[o] * (1 - mix) + (r / n) * mix)
      out[o + 1] = Math.round(copy[o + 1] * (1 - mix) + (g / n) * mix)
      out[o + 2] = Math.round(copy[o + 2] * (1 - mix) + (b / n) * mix)
    }
  }
}

function blurSeamOnly(
  out: Uint8ClampedArray,
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number
) {
  const dist = distToOutside(mask, width, height, radius)
  const copy = out.slice()
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x
      if (!mask[idx]) continue
      if (dist[idx] > radius) continue
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
      const t = 0.55 * (1 - (dist[idx] - 1) / radius)
      out[o] = Math.round(copy[o] * (1 - t) + (r / n) * t)
      out[o + 1] = Math.round(copy[o + 1] * (1 - t) + (g / n) * t)
      out[o + 2] = Math.round(copy[o + 2] * (1 - t) + (b / n) * t)
    }
  }
}

function clamp(v: number) {
  return v < 0 ? 0 : v > 255 ? 255 : v
}
