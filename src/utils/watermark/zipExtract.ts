import JSZip from 'jszip'
import { isImageName, MAX_IMAGES, MAX_ZIP_BYTES } from './fileRules'

export async function extractImagesFromZip(file: File): Promise<File[]> {
  if (file.size > MAX_ZIP_BYTES) {
    throw new Error(`压缩包不能超过 ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)}MB`)
  }

  const zip = await JSZip.loadAsync(file)
  const entries = Object.values(zip.files).filter((entry) => !entry.dir && isImageName(entry.name))
  if (!entries.length) {
    throw new Error('压缩包内未找到支持的图片（jpg/png/webp/bmp）')
  }
  if (entries.length > MAX_IMAGES) {
    throw new Error(`压缩包内图片不能超过 ${MAX_IMAGES} 张`)
  }

  const files: File[] = []
  for (const entry of entries) {
    const blob = await entry.async('blob')
    const name = entry.name.split('/').pop() || entry.name
    files.push(new File([blob], name, { type: blob.type || 'image/png' }))
  }
  return files
}
