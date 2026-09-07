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

export type FolderSaveFailedItem = {
  /** 写入时使用的下载 URL（与入参一致） */
  url: string
  label: string
  reason: string
}

export type FolderSaveOutcome =
  | { mode: 'folder'; cancelled: true }
  | {
      mode: 'folder'
      cancelled?: false
      ok: number
      fail: number
      failed: FolderSaveFailedItem[]
    }
  | { mode: 'unsupported' }

export type PickFolderResult =
  | { ok: true; dir: FileSystemDirectoryHandle }
  | { ok: false; cancelled: true }
  | { ok: false; unsupported: true }
  | { ok: false; denied: true }

export type WriteOneResult =
  | { ok: true; name: string; label: string }
  | { ok: false; url: string; label: string; reason: string }

/**
 * 传输空闲超时：只要持续收到数据就不限制总时长。
 * 避免大文件 / 慢网在固定 90s 硬超时下被掐断，留下打不开的半截文件。
 */
const DOWNLOAD_IDLE_TIMEOUT_MS = 120_000

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

/** 是否像代理 token 过期 / 资源不存在（可触发重新解析） */
export function isExpiredDownloadReason(reason: string): boolean {
  return /HTTP\s*404|过期|不存在|NOT_FOUND|资源无效/i.test(reason)
}

/** Windows / Chromium File System Access 会拒绝的保留名 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/**
 * 生成 File System Access API 可接受的文件名。
 * Chromium 会拒绝：空名、`.`/`..`、含 / \、控制字符、尾随 `.`/空格、部分 Windows 保留名。
 */
function sanitizeFilename(name: string, fallback = 'download.bin'): string {
  let cleaned = name
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  // 去掉尾随点/空格（Windows 组件名不允许）
  cleaned = cleaned.replace(/[.\s]+$/g, '')

  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback
  if (WINDOWS_RESERVED.test(cleaned)) cleaned = `_${cleaned}`

  // 路径组件过长时截断，尽量保留扩展名
  if (cleaned.length > 120) {
    const { stem, ext } = splitName(cleaned)
    const maxStem = Math.max(8, 120 - ext.length)
    cleaned = `${stem.slice(0, maxStem).replace(/[.\s]+$/g, '') || 'download'}${ext}`
  }

  return cleaned || fallback
}

function parseFilenameFromDisposition(header: string | null): string | null {
  if (!header) return null
  const utf8 = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)
  if (utf8?.[1]) {
    try {
      const decoded = decodeURIComponent(utf8[1].trim().replace(/^["']|["']$/g, ''))
      const safe = sanitizeFilename(decoded)
      return safe === 'download.bin' && !decoded.trim() ? null : safe
    } catch {
      /* ignore */
    }
  }
  const plain = /filename\s*=\s*("?)([^";]+)\1/i.exec(header)
  if (plain?.[2]) {
    const safe = sanitizeFilename(plain[2].trim())
    return safe === 'download.bin' && !plain[2].trim() ? null : safe
  }
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
function nextUniqueFilename(used: Set<string>, preferred: string, fallback?: string): string {
  const base = sanitizeFilename(preferred, fallback || 'download.bin')
  const { stem, ext } = splitName(base)
  const safeStem = sanitizeFilename(stem, 'download') || 'download'
  let candidate = sanitizeFilename(`${safeStem}${ext}`, fallback || 'download.bin')
  let n = 1
  while (used.has(candidate.toLowerCase())) {
    candidate = sanitizeFilename(`${safeStem} (${n})${ext}`, `download-${n}${ext || '.bin'}`)
    n += 1
  }
  used.add(candidate.toLowerCase())
  return candidate
}

function isInvalidFilenameError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /name is not allowed/i.test(msg)
}

async function getWritableFileHandle(
  dir: FileSystemDirectoryHandle,
  filename: string,
  usedNames: Set<string>,
  index: number,
  contentType: string | null
): Promise<{ fileHandle: FileSystemFileHandle; name: string }> {
  try {
    const fileHandle = await dir.getFileHandle(filename, { create: true })
    return { fileHandle, name: filename }
  } catch (err) {
    if (!isInvalidFilenameError(err)) throw err
    // 标题派生名被浏览器拒绝时，回退到安全序号名并重试一次
    usedNames.delete(filename.toLowerCase())
    const safeName = nextUniqueFilename(usedNames, fallbackFilename(index, contentType))
    const fileHandle = await dir.getFileHandle(safeName, { create: true })
    return { fileHandle, name: safeName }
  }
}

/** 在用户手势内确认目录可写；选目录后、长耗时任务前调用。 */
export async function ensureDirectoryWritable(dir: FileSystemDirectoryHandle): Promise<boolean> {
  const opts = { mode: 'readwrite' as const }
  try {
    if (typeof dir.queryPermission === 'function') {
      const state = await dir.queryPermission(opts)
      if (state === 'granted') return true
    }
    if (typeof dir.requestPermission === 'function') {
      const state = await dir.requestPermission(opts)
      return state === 'granted'
    }
    // 旧实现无 permission API 时，假定选目录即已授权
    return true
  } catch {
    return false
  }
}

/** 让出主线程，保证进度条与点击可响应 */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0)
  })
}

/** 空闲超时：有数据时 ping 重置；长时间无字节才 abort */
function createIdleTimeout(ms: number): {
  signal: AbortSignal
  ping: () => void
  clear: () => void
} {
  const controller = new AbortController()
  let id: number | undefined
  const arm = () => {
    if (id !== undefined) window.clearTimeout(id)
    id = window.setTimeout(() => {
      controller.abort(
        new DOMException(
          `下载中断：超过 ${Math.round(ms / 1000)}s 未收到数据`,
          'TimeoutError'
        )
      )
    }, ms)
  }
  arm()
  return {
    signal: controller.signal,
    ping: arm,
    clear: () => {
      if (id !== undefined) window.clearTimeout(id)
    }
  }
}

function failReason(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return err.message || '下载中断，已跳过（未保存不完整文件）'
    }
    if (err.name === 'NotAllowedError') {
      return '浏览器未授权写入所选文件夹，请重新选择文件夹并允许访问'
    }
  }
  if (err instanceof Error) {
    if (/下载不完整/i.test(err.message)) return err.message
    if (/aborted|timeout|超时|中断/i.test(err.message)) {
      return err.message.includes('未收到数据')
        ? err.message
        : '下载中断，已跳过（未保存不完整文件）'
    }
    if (/name is not allowed/i.test(err.message)) {
      return '文件名不合法，已无法保存（可重试下载）'
    }
    if (/not allowed by the user agent|NotAllowedError/i.test(err.message)) {
      return '浏览器未授权写入所选文件夹，请重新选择文件夹并允许访问'
    }
    return err.message || '下载失败'
  }
  return '下载失败'
}

async function removePartialFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  usedNames: Set<string>
): Promise<void> {
  usedNames.delete(name.toLowerCase())
  try {
    await dir.removeEntry(name)
  } catch {
    /* 文件可能尚未创建或已被 abort 清理 */
  }
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
  idle: { signal: AbortSignal; ping: () => void }
): Promise<string> {
  const response = await fetch(url, { signal: idle.signal })
  if (!response.ok) {
    throw new Error(`下载失败（HTTP ${response.status}）`)
  }

  const contentType = response.headers.get('Content-Type')
  const fromHeader = parseFilenameFromDisposition(response.headers.get('Content-Disposition'))
  const preferred = fromHeader || fallbackFilename(index, contentType)
  const filename = nextUniqueFilename(usedNames, preferred, fallbackFilename(index, contentType))
  const { fileHandle, name } = await getWritableFileHandle(
    dir,
    filename,
    usedNames,
    index,
    contentType
  )

  let writable: FileSystemWritableFileStream
  try {
    writable = await fileHandle.createWritable()
  } catch (err) {
    await removePartialFile(dir, name, usedNames)
    if (
      (err instanceof DOMException && err.name === 'NotAllowedError') ||
      (err instanceof Error && /not allowed by the user agent/i.test(err.message))
    ) {
      throw new DOMException(
        '浏览器未授权写入所选文件夹，请重新选择文件夹并允许访问',
        'NotAllowedError'
      )
    }
    throw err
  }

  const expectedLen = Number(response.headers.get('Content-Length') || '') || 0

  try {
    let received = 0
    if (response.body) {
      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          idle.ping()
          received += value.byteLength
          await writable.write(value)
        }
      } catch (err) {
        try {
          await reader.cancel()
        } catch {
          /* ignore */
        }
        throw err
      }
      await writable.close()
    } else {
      const buffer = await response.arrayBuffer()
      idle.signal.throwIfAborted()
      idle.ping()
      received = buffer.byteLength
      await writable.write(buffer)
      await writable.close()
    }

    if (expectedLen > 0 && received !== expectedLen) {
      throw new Error(`下载不完整（已收 ${received} / 预期 ${expectedLen} 字节），未保存`)
    }
  } catch (err) {
    try {
      await writable.abort()
    } catch {
      /* ignore */
    }
    await removePartialFile(dir, name, usedNames)
    throw err
  }

  return name
}

function normalizeItems(urlsOrItems: Array<string | FolderSaveItem>): FolderSaveItem[] {
  return urlsOrItems.map((item) => (typeof item === 'string' ? { url: item } : item))
}

/** 在用户点击手势内调用：弹出选目录，并立即确认可写权限。 */
export async function pickDownloadFolder(): Promise<PickFolderResult> {
  const showPicker = pickerWindow().showDirectoryPicker
  if (!showPicker) return { ok: false, unsupported: true }
  try {
    const dir = await showPicker({ id: 'media-parse-downloads', mode: 'readwrite' })
    const writable = await ensureDirectoryWritable(dir)
    if (!writable) return { ok: false, denied: true }
    return { ok: true, dir }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, cancelled: true }
    }
    if (
      (err instanceof DOMException && err.name === 'NotAllowedError') ||
      (err instanceof Error && /not allowed by the user agent/i.test(err.message))
    ) {
      return { ok: false, denied: true }
    }
    throw err
  }
}

/**
 * 将单个 URL 写入已选目录。
 * usedNames 可跨多次调用共享，避免文件名冲突。
 * timeoutMs 表示「无数据空闲超时」，有传输进度时不限制总时长。
 */
export async function writeOneUrlToDirectory(
  dir: FileSystemDirectoryHandle,
  item: FolderSaveItem,
  options?: {
    index?: number
    usedNames?: Set<string>
    /** 无数据空闲超时（ms），默认 120s；持续有数据则不限总时长 */
    timeoutMs?: number
  }
): Promise<WriteOneResult> {
  const index = options?.index ?? 0
  const usedNames = options?.usedNames ?? new Set<string>()
  const timeoutMs = options?.timeoutMs ?? DOWNLOAD_IDLE_TIMEOUT_MS
  const label = item.label?.trim() || `第 ${index + 1} 个文件（${shortUrlHint(item.url)}）`
  const idle = createIdleTimeout(timeoutMs)
  try {
    const name = await writeUrlToDirectory(dir, item.url, index, usedNames, idle)
    return { ok: true, name, label }
  } catch (err) {
    return { ok: false, url: item.url, label, reason: failReason(err) }
  } finally {
    idle.clear()
    await yieldToUi()
  }
}

/** 向已选目录批量写入（不弹选目录）。默认有限并发，避免串行过慢。 */
export async function writeUrlsToDirectory(
  dir: FileSystemDirectoryHandle,
  urlsOrItems: Array<string | FolderSaveItem>,
  options?: {
    onProgress?: (progress: FolderSaveProgress) => void
    /** 无数据空闲超时（ms）；持续有数据则不限总时长 */
    timeoutMs?: number
    usedNames?: Set<string>
    /** 文件名序号起点，默认 0 */
    startIndex?: number
    /** 同时写入的文件数，默认 3 */
    concurrency?: number
  }
): Promise<{ ok: number; fail: number; failed: FolderSaveFailedItem[] }> {
  const items = normalizeItems(urlsOrItems)
  let ok = 0
  let fail = 0
  let finished = 0
  const failed: FolderSaveFailedItem[] = []
  const usedNames = options?.usedNames ?? new Set<string>()
  const startIndex = options?.startIndex ?? 0
  const total = items.length
  const concurrency = Math.max(1, options?.concurrency ?? 3)

  let cursor = 0

  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      const item = items[i]
      const label = item.label?.trim() || `第 ${i + 1} 个文件（${shortUrlHint(item.url)}）`
      options?.onProgress?.({
        done: finished,
        total,
        currentIndex: i + 1,
        currentLabel: label,
        currentName: label,
        phase: 'start'
      })

      const result = await writeOneUrlToDirectory(dir, item, {
        index: startIndex + i,
        usedNames,
        timeoutMs: options?.timeoutMs
      })

      finished += 1
      if (result.ok) {
        ok += 1
        options?.onProgress?.({
          done: finished,
          total,
          currentIndex: i + 1,
          currentLabel: label,
          currentName: result.name,
          phase: 'ok'
        })
      } else {
        fail += 1
        failed.push({ url: result.url, label: result.label, reason: result.reason })
        options?.onProgress?.({
          done: finished,
          total,
          currentIndex: i + 1,
          currentLabel: label,
          currentName: label,
          phase: 'fail',
          failReason: result.reason
        })
      }
    }
  }

  const workers = Math.min(concurrency, items.length || 1)
  if (items.length) {
    await Promise.all(Array.from({ length: workers }, () => worker()))
  }

  return { ok, fail, failed }
}

/**
 * 在用户点击手势内调用：弹出选目录，再逐个 fetch 写入。
 * 单文件长时间无数据会跳过并清理半截文件，整批一定会结束。
 * 不支持 API 时返回 unsupported，由调用方降级。
 */
export async function saveUrlsToPickedFolder(
  urlsOrItems: Array<string | FolderSaveItem>,
  options?: {
    onProgress?: (progress: FolderSaveProgress) => void
    timeoutMs?: number
    concurrency?: number
  }
): Promise<FolderSaveOutcome> {
  const picked = await pickDownloadFolder()
  if (!picked.ok) {
    if ('unsupported' in picked && picked.unsupported) return { mode: 'unsupported' }
    return { mode: 'folder', cancelled: true }
  }

  const items = normalizeItems(urlsOrItems)
  if (!items.length) return { mode: 'folder', ok: 0, fail: 0, failed: [] }

  const result = await writeUrlsToDirectory(picked.dir, items, options)
  return { mode: 'folder', ok: result.ok, fail: result.fail, failed: result.failed }
}
