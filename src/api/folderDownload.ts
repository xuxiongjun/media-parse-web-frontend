/** File System Access API：选目录后批量写入，避免浏览器「多个下载」拦截。 */

export type FolderSaveProgress = {
  done: number
  total: number
  currentName?: string
}

export type FolderSaveOutcome =
  | { mode: 'folder'; cancelled: true }
  | { mode: 'folder'; cancelled?: false; ok: number; fail: number }
  | { mode: 'unsupported' }

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: {
    id?: string
    mode?: 'read' | 'readwrite'
    startIn?: string
  }) => Promise<FileSystemDirectoryHandle>
}

function pickerWindow(): DirectoryPickerWindow {
  return window as DirectoryPickerWindow
}

export function canUseDirectoryPicker(): boolean {
  return typeof pickerWindow().showDirectoryPicker === 'function'
}

function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || 'download.bin'
}

function parseFilenameFromDisposition(header: string | null): string | null {
  if (!header) return null
  const utf8 = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)
  if (utf8?.[1]) {
    try {
      return sanitizeFilename(decodeURIComponent(utf8[1].trim().replace(/^["']|["']$/g, '')))
    } catch {
      /* ignore */
    }
  }
  const plain = /filename\s*=\s*("?)([^";]+)\1/i.exec(header)
  if (plain?.[2]) return sanitizeFilename(plain[2].trim())
  return null
}

function extFromContentType(contentType: string | null): string {
  if (!contentType) return 'bin'
  const ct = contentType.split(';')[0].trim().toLowerCase()
  if (ct.includes('mp4') || ct.includes('octet-stream')) return 'mp4'
  if (ct.includes('webm')) return 'webm'
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg'
  if (ct.includes('png')) return 'png'
  if (ct.includes('webp')) return 'webp'
  if (ct.includes('gif')) return 'gif'
  return 'bin'
}

function fallbackFilename(index: number, contentType: string | null): string {
  return `media-${index + 1}.${extFromContentType(contentType)}`
}

function splitName(filename: string): { stem: string; ext: string } {
  const i = filename.lastIndexOf('.')
  if (i <= 0) return { stem: filename, ext: '' }
  return { stem: filename.slice(0, i), ext: filename.slice(i) }
}

/** 用内存集合去重，避免对目录反复 getFileHandle 探测导致卡顿 */
function nextUniqueFilename(used: Set<string>, preferred: string): string {
  const base = sanitizeFilename(preferred)
  const { stem, ext } = splitName(base)
  let candidate = base
  let n = 1
  while (used.has(candidate.toLowerCase())) {
    candidate = `${stem} (${n})${ext}`
    n += 1
  }
  used.add(candidate.toLowerCase())
  return candidate
}

/** 让出主线程，保证进度条与点击可响应 */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0)
  })
}

async function writeUrlToDirectory(
  dir: FileSystemDirectoryHandle,
  url: string,
  index: number,
  usedNames: Set<string>
): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`下载失败（HTTP ${response.status}）`)
  }

  const fromHeader = parseFilenameFromDisposition(response.headers.get('Content-Disposition'))
  const preferred = fromHeader || fallbackFilename(index, response.headers.get('Content-Type'))
  const filename = nextUniqueFilename(usedNames, preferred)
  const fileHandle = await dir.getFileHandle(filename, { create: true })
  const writable = await fileHandle.createWritable()

  try {
    if (response.body) {
      await response.body.pipeTo(writable)
    } else {
      const buffer = await response.arrayBuffer()
      await writable.write(buffer)
      await writable.close()
    }
  } catch (err) {
    try {
      await writable.abort()
    } catch {
      /* ignore */
    }
    throw err
  }

  return filename
}

/**
 * 在用户点击手势内调用：弹出选目录，再逐个 fetch 写入。
 * 不支持 API 时返回 unsupported，由调用方降级。
 */
export async function saveUrlsToPickedFolder(
  urls: string[],
  options?: {
    onProgress?: (progress: FolderSaveProgress) => void
  }
): Promise<FolderSaveOutcome> {
  const showPicker = pickerWindow().showDirectoryPicker
  if (!showPicker) return { mode: 'unsupported' }
  if (!urls.length) return { mode: 'folder', ok: 0, fail: 0 }

  let dir: FileSystemDirectoryHandle
  try {
    dir = await showPicker({ id: 'media-parse-downloads', mode: 'readwrite' })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { mode: 'folder', cancelled: true }
    }
    throw err
  }

  let ok = 0
  let fail = 0
  const total = urls.length
  const usedNames = new Set<string>()

  for (let i = 0; i < urls.length; i++) {
    options?.onProgress?.({ done: i, total, currentName: `第 ${i + 1} 个文件` })
    try {
      const name = await writeUrlToDirectory(dir, urls[i], i, usedNames)
      ok += 1
      options?.onProgress?.({ done: i + 1, total, currentName: name })
    } catch {
      fail += 1
      options?.onProgress?.({ done: i + 1, total })
    }
    // 每写完一个文件让出主线程，避免大批量时页面假死
    await yieldToUi()
  }

  return { mode: 'folder', ok, fail }
}
