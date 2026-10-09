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
  /** 源码提取后可直接下载，无需再跑本地去水印 */
  readyAsOriginal?: boolean
  /** 源码视频是否已确认与带水印档不是同一文件。原图默认视为干净。 */
  cleanSource?: boolean
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
