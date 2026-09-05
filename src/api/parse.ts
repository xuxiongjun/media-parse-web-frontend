import axios from 'axios'

export interface ParseResult {
  platform: string
  mediaType?: 'video' | 'image' | string
  title: string
  author?: string
  coverProxyUrl?: string
  videoProxyUrl?: string
  imageProxyUrls?: string[]
  duration?: number
  expireAt?: number
}

export interface ApiErrorBody {
  code?: string
  message?: string
}

const http = axios.create({
  timeout: 45000
})

export async function parseShareUrl(url: string): Promise<ParseResult> {
  const { data } = await http.post<ParseResult>('/api/parse', { url })
  return data
}

export function mediaDownloadUrl(proxyPath: string): string {
  const joiner = proxyPath.includes('?') ? '&' : '?'
  return `${proxyPath}${joiner}download=1`
}

export function platformLabel(platform: string): string {
  if (platform === 'douyin') return '抖音'
  if (platform === 'xiaohongshu') return '小红书'
  return platform
}

export function isImageResult(result: ParseResult | null | undefined): boolean {
  if (!result) return false
  if (result.mediaType === 'image') return true
  return Array.isArray(result.imageProxyUrls) && result.imageProxyUrls.length > 0 && !result.videoProxyUrl
}

const URL_RE = /https?:\/\/[\w\-./?%&=#:+~]+/gi

/** 从分享文案中取出第一个链接（与后端行为一致） */
export function extractFirstUrl(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  if (text.startsWith('http://') || text.startsWith('https://')) {
    const m = text.match(URL_RE)
    return m?.[0] ?? text.split(/\s/)[0] ?? null
  }
  const m = text.match(URL_RE)
  return m?.[0] ?? null
}

/**
 * 将多段粘贴拆成待解析条目：优先按行（每行一条分享文案），
 * 若整段无换行但含多个 URL，则按 URL 拆分。
 */
export function collectShareEntries(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const fromLines: string[] = []
  for (const line of lines) {
    if (extractFirstUrl(line)) fromLines.push(line)
  }

  let entries = fromLines
  if (entries.length === 0) {
    const urls = trimmed.match(URL_RE) ?? []
    entries = urls.map((u) => u.trim()).filter(Boolean)
  }

  const seen = new Set<string>()
  const unique: string[] = []
  for (const entry of entries) {
    const key = (extractFirstUrl(entry) || entry).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(entry)
  }
  return unique
}
