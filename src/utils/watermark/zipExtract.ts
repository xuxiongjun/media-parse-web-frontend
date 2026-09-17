import JSZip from 'jszip'
import { isImageName } from './fileRules'

export async function extractImagesFromZip(file: File): Promise<File[]> {
  const zip = await JSZip.loadAsync(file)
  const entries = Object.values(zip.files).filter((entry) => !entry.dir && isImageName(entry.name))
  if (!entries.length) {
    throw new Error('压缩包内未找到支持的图片（jpg/png/webp/bmp）')
  }

  const files: File[] = []
  for (const entry of entries) {
    const blob = await entry.async('blob')
    const name = entry.name.split('/').pop() || entry.name
    files.push(new File([blob], name, { type: blob.type || 'image/png' }))
  }
  return files
}
