import axios from 'axios'

export interface ParseResult {
  platform: string
  title: string
  author?: string
  coverProxyUrl?: string
  videoProxyUrl: string
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
