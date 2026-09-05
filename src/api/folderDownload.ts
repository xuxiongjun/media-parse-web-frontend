/** File System Access API：选目录后批量写入，避免浏览器「多个下载」拦截。 */

export type FolderSaveProgress = {
  done: number
  total: number
  /** 当前正在处理的序号（1-based） */
  currentIndex?: number
  currentName?: string
  currentLabel?: string
  phase?: 'start' | 'ok' | 'fail'
  failReason?: string
}

export type FolderSaveItem = {
  url: string
  /** 展示用：对应解析结果条目说明 */
  label?: string
}

export type FolderSaveOutcome =
  | { mode: 'folder'; cancelled: true }
  | {
      mode: 'folder'
      cancelled?: false
      ok: number
      fail: number
      failed: Array<{ label: string; reason: string }>
    }
  | { mode: 'unsupported' }

/** 单文件拉取+写入上限；超时则跳过，保证整批能跑完 */
const DOWNLOAD_TIMEOUT_MS = 90_000

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

function createTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController()
  const id = window.setTimeout(() => {
    controller.abort(new DOMException(`下载超时（${Math.round(ms / 1000)}s）`, 'TimeoutError'))
  }, ms)
  return {
    signal: controller.signal,
    clear: () => window.clearTimeout(id)
  }
}

function failReason(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return err.message || '下载超时，已跳过'
    }
  }
  if (err instanceof Error) {
    if (/aborted|timeout|超时/i.test(err.message)) return '下载超时，已跳过'
    return err.message || '下载失败'
  }
  return '下载失败'
}

function shortUrlHint(url: string): string {
  try {
    const u = new URL(url, window.location.origin)
    const token = u.pathname.split('/').filter(Boolean).pop() || ''
    return token ? token.slice(0, 12) : u.pathname
  } catch {
    return url.slice(0, 24)
  }
}

async function writeUrlToDirectory(
  dir: FileSystemDirectoryHandle,
  url: string,
  index: number,
  usedNames: Set<string>,
  signal: AbortSignal
): Promise<string> {
  const response = await fetch(url, { signal })
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
      await response.body.pipeTo(writable, { signal })
    } else {
      const buffer = await response.arrayBuffer()
      signal.throwIfAborted()
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

function normalizeItems(urlsOrItems: Array<string | FolderSaveItem>): FolderSaveItem[] {
  return urlsOrItems.map((item) => (typeof item === 'string' ? { url: item } : item))
}

/**
 * 在用户点击手势内调用：弹出选目录，再逐个 fetch 写入。
 * 单文件超时会跳过并继续，整批一定会结束。
 * 不支持 API 时返回 unsupported，由调用方降级。
 */
export async function saveUrlsToPickedFolder(
  urlsOrItems: Array<string | FolderSaveItem>,
  options?: {
    onProgress?: (progress: FolderSaveProgress) => void
    timeoutMs?: number
  }
): Promise<FolderSaveOutcome> {
  const showPicker = pickerWindow().showDirectoryPicker
  if (!showPicker) return { mode: 'unsupported' }

  const items = normalizeItems(urlsOrItems)
  if (!items.length) return { mode: 'folder', ok: 0, fail: 0, failed: [] }

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
  const total = items.length
  const usedNames = new Set<string>()
  const failed: Array<{ label: string; reason: string }> = []
  const timeoutMs = options?.timeoutMs ?? DOWNLOAD_TIMEOUT_MS

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const label = item.label?.trim() || `第 ${i + 1} 个文件（${shortUrlHint(item.url)}）`
    options?.onProgress?.({
      done: i,
      total,
      currentIndex: i + 1,
      currentLabel: label,
      currentName: label,
      phase: 'start'
    })

    const timeout = createTimeout(timeoutMs)
    try {
      const name = await writeUrlToDirectory(dir, item.url, i, usedNames, timeout.signal)
      ok += 1
      options?.onProgress?.({
        done: i + 1,
        total,
        currentIndex: i + 1,
        currentLabel: label,
        currentName: name,
        phase: 'ok'
      })
    } catch (err) {
      const reason = failReason(err)
      fail += 1
      failed.push({ label, reason })
      options?.onProgress?.({
        done: i + 1,
        total,
        currentIndex: i + 1,
        currentLabel: label,
        currentName: label,
        phase: 'fail',
        failReason: reason
      })
    } finally {
      timeout.clear()
    }

    await yieldToUi()
  }

  return { mode: 'folder', ok, fail, failed }
}
