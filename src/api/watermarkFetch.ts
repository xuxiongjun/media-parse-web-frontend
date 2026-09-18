import axios from 'axios'
import {
  API_BASE,
  collectShareEntries,
  extractFirstUrl,
  resolveApiUrl,
  type ApiErrorBody
} from './parse'

export interface FetchImagesResult {
  platform: string
  title?: string
  imageProxyUrls: string[]
  expireAt?: number
}

const http = axios.create({
  baseURL: API_BASE || undefined,
  timeout: 180000
})

function withAbsoluteUrls(data: FetchImagesResult): FetchImagesResult {
  return {
    ...data,
    imageProxyUrls: (data.imageProxyUrls || []).map((u) => resolveApiUrl(u))
  }
}

/** 从豆包等 AI 聊天 / 分享链接抓取图片代理地址 */
export async function fetchChatImages(url: string): Promise<FetchImagesResult> {
  const { data } = await http.post<FetchImagesResult>('/api/watermark/fetch-images', { url })
  return withAbsoluteUrls(data)
}

export function platformAiLabel(platform: string): string {
  if (platform === 'doubao') return '豆包'
  if (platform === 'yuanbao') return '元宝'
  if (platform === 'jimeng') return '即梦'
  if (platform === 'tongyi') return '通义'
  if (platform === 'chatgpt') return 'ChatGPT'
  return platform
}

export function fetchImagesErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as ApiErrorBody | undefined
    return data?.message || '拉取图片失败，请稍后重试'
  }
  return '拉取图片失败，请稍后重试'
}

export function isFetchRateLimited(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false
  if (err.response?.status === 429) return true
  const data = err.response?.data as ApiErrorBody | undefined
  return data?.code === 'RATE_LIMIT'
}

/** 通过代理 URL 拉取图片并转为 File，供去水印任务使用 */
export async function proxyUrlToFile(proxyUrl: string, filename: string): Promise<File> {
  const res = await fetch(proxyUrl, { credentials: 'omit', cache: 'no-store' })
  if (!res.ok) {
    throw new Error(`下载图片失败（${res.status}）`)
  }
  const buf = await res.arrayBuffer()
  if (buf.byteLength < 8_192) {
    throw new Error(`图片过小（${buf.byteLength}B），可能不是原图`)
  }
  if (!looksLikeImageBytes(buf)) {
    throw new Error('下载内容不是有效图片')
  }
  const type = sniffImageType(buf) || res.headers.get('content-type') || 'image/jpeg'
  const name = ensureExt(filename || guessNameFromType(type), type)
  return new File([buf], name, { type })
}

function looksLikeImageBytes(buf: ArrayBuffer): boolean {
  const b = new Uint8Array(buf)
  if (b.length < 12) return false
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true
  if (b[0] === 0xff && b[1] === 0xd8) return true
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return true
  }
  return false
}

function sniffImageType(buf: ArrayBuffer): string | null {
  const b = new Uint8Array(buf)
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif'
  if (b[0] === 0x52 && b[1] === 0x49) return 'image/webp'
  return null
}

function ensureExt(name: string, type: string): string {
  if (/\.(png|jpe?g|webp|gif)$/i.test(name)) return name
  if (type.includes('png')) return `${name}.png`
  if (type.includes('webp')) return `${name}.webp`
  if (type.includes('gif')) return `${name}.gif`
  return `${name}.jpg`
}

function guessNameFromType(type: string): string {
  if (type.includes('png')) return 'image.png'
  if (type.includes('webp')) return 'image.webp'
  return 'image.jpg'
}

export { collectShareEntries, extractFirstUrl }
