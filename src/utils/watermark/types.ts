export type UploadMode = 'images' | 'zip' | 'video'

export type TaskStatus = 'pending' | 'processing' | 'done' | 'error'

export interface WatermarkTask {
  id: string
  name: string
  kind: 'image' | 'video'
  sourceFile: File
  status: TaskStatus
  error: string | null
  originalUrl: string | null
  resultUrl: string | null
  resultBlob: Blob | null
  maskPreviewUrl: string | null
  regionLabel: string | null
  /** 源码提取的无水印原图，无需再跑去水印，可直接下载 */
  readyAsOriginal?: boolean
}

export interface WatermarkBox {
  x: number
  y: number
  w: number
  h: number
}

export interface DetectResult {
  mask: Uint8Array
  width: number
  height: number
  confidence: number
  regionLabel: string
  box: WatermarkBox
}
