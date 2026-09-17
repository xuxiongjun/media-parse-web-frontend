/** 基于邻域扩散的简单 inpaint，适合浏览器免费算力 */
export function inpaintImageData(imageData: ImageData, mask: Uint8Array, passes = 10): ImageData {
  const { width, height, data } = imageData
  const out = new Uint8ClampedArray(data)
  const workMask = mask.slice()

  for (let pass = 0; pass < passes; pass++) {
    let changed = false
    const nextMask = workMask.slice()

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x
        if (!workMask[idx]) continue

        let r = 0
        let g = 0
        let b = 0
        let count = 0
        const neighbors = [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
          [x - 1, y - 1],
          [x + 1, y - 1],
          [x - 1, y + 1],
          [x + 1, y + 1]
        ]

        for (const [nx, ny] of neighbors) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const ni = ny * width + nx
          if (workMask[ni]) continue
          const o = ni * 4
          r += out[o]
          g += out[o + 1]
          b += out[o + 2]
          count++
        }

        if (count > 0) {
          const o = idx * 4
          out[o] = Math.round(r / count)
          out[o + 1] = Math.round(g / count)
          out[o + 2] = Math.round(b / count)
          nextMask[idx] = 0
          changed = true
        }
      }
    }

    for (let i = 0; i < workMask.length; i++) workMask[i] = nextMask[i]
    if (!changed) break
  }

  return new ImageData(out, width, height)
}
