export const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp'])
export const VIDEO_EXT = new Set(['mp4', 'webm', 'mov'])
export const MAX_IMAGES = 30
export const MAX_ZIP_BYTES = 120 * 1024 * 1024
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_VIDEO_BYTES = 80 * 1024 * 1024

export function extOf(name: string) {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

export function isImageName(name: string) {
  return IMAGE_EXT.has(extOf(name))
}

export function isVideoName(name: string) {
  return VIDEO_EXT.has(extOf(name))
}

export function isZipFile(file: File) {
  return extOf(file.name) === 'zip' || file.type === 'application/zip'
}
