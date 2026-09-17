import { detectWatermarkMask, maskToPreviewData } from '../detectMask'
import { inpaintImageData } from '../inpaint'

export type ImageWorkerRequest = {
  id: string
  width: number
  height: number
  /** RGBA buffer，可转移 */
  buffer: ArrayBuffer
}

export type ImageWorkerResponse =
  | {
      id: string
      ok: true
      width: number
      height: number
      resultBuffer: ArrayBuffer
      maskPreviewBuffer: ArrayBuffer
      regionLabel: string
      confidence: number
    }
  | {
      id: string
      ok: false
      error: string
    }

self.onmessage = (event: MessageEvent<ImageWorkerRequest>) => {
  const { id, width, height, buffer } = event.data
  try {
    const imageData = new ImageData(new Uint8ClampedArray(buffer), width, height)
    const detected = detectWatermarkMask(imageData)
    const repaired = inpaintImageData(imageData, detected.mask)
    const maskPreview = maskToPreviewData(detected.mask, width, height)

    const response: ImageWorkerResponse = {
      id,
      ok: true,
      width,
      height,
      resultBuffer: repaired.data.buffer,
      maskPreviewBuffer: maskPreview.buffer,
      regionLabel: detected.regionLabel,
      confidence: detected.confidence
    }

    ;(self as DedicatedWorkerGlobalScope).postMessage(response, [
      response.resultBuffer,
      response.maskPreviewBuffer
    ])
  } catch (e) {
    const response: ImageWorkerResponse = {
      id,
      ok: false,
      error: e instanceof Error ? e.message : '图片处理失败'
    }
    ;(self as DedicatedWorkerGlobalScope).postMessage(response)
  }
}
