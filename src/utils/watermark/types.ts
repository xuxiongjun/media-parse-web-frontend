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
}

export interface DetectResult {
  mask: Uint8Array
  width: number
  height: number
  confidence: number
  regionLabel: string
}
