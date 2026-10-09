/** 把豆包 fallback_api 换成无水印档，并解开 fplay 返回的播放地址。 */

const MAT_XOR = 0x5a
const PACKED_MAT = [
  0x17, 0x8e, 0x98, 0xbc, 0xe2, 0x6b, 0x38, 0x53, 0x54, 0x08, 0xe9, 0x9d, 0xfc, 0x29, 0x61, 0xfe,
  0x46, 0xe8, 0x1c, 0x71, 0xd8, 0xc0, 0xef, 0xd0, 0x43, 0x31, 0x63, 0x81, 0x0d, 0x4d, 0x2f, 0x7e,
  0xae, 0xc1, 0xf5, 0x25, 0x52, 0xb2, 0x8c, 0xd7, 0x7c, 0xfd, 0x74, 0x6d, 0x9b, 0xf3, 0x00, 0x75,
  0x45, 0x5f, 0xff, 0x42, 0xc8, 0xf4, 0xa8, 0xce, 0xcd, 0x68, 0xec, 0x70, 0x62, 0xf0, 0x87, 0x02
]

export interface DoubaoPlaySource {
  url: string
  fileHash: string | null
  size: number
  quality: string
}

export function unwatermarkedFplayUrl(fallbackApi: string): string {
  const url = new URL(fallbackApi)
  url.searchParams.set('channel', 'no')
  url.searchParams.set('codec_type', '8')
  url.searchParams.set('logo_type', 'unwatermarked')
  return url.href
}

export async function resolveDoubaoUnwatermarked(fallbackApi: string): Promise<DoubaoPlaySource> {
  const endpoint = unwatermarkedFplayUrl(fallbackApi)
  const res = await fetch(endpoint, {
    credentials: 'omit',
    mode: 'cors',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    headers: { Accept: 'application/json' }
  })
  if (!res.ok) {
    throw new Error(`视频接口失败（${res.status}）`)
  }
  const text = (await res.text()).replace(/^\uFEFF/, '')
  const payload = JSON.parse(text) as unknown
  const data = getVideoData(payload)
  const selected = pickPlayItem(data)
  if (!selected) throw new Error('接口没有返回视频地址')
  const seed =
    pickSeed(payload) || new URL(fallbackApi).searchParams.get('key_seed') || ''
  const url = await resolvePlayToken(selected.token, seed)
  if (!url) throw new Error('未能解析无水印视频地址')
  return {
    url,
    fileHash: selected.fileHash,
    size: selected.size,
    quality: selected.quality
  }
}

/** 与源码里的 download_filehash 不同，才认为拿到了另一份无水印原片。 */
export function isDifferentMedia(fileHash: string | null, watermarkHash: string | null, quality: string): boolean {
  if (fileHash && watermarkHash) {
    return fileHash.toLowerCase() !== watermarkHash.toLowerCase()
  }
  return quality.toLowerCase() === 'original'
}

interface PlayItem {
  token: string
  fileHash: string | null
  size: number
  quality: string
  pixels: number
  bitrate: number
}

function getVideoData(payload: unknown): Record<string, unknown> {
  const root = asRecord(payload)
  const info = asRecord(root.video_info) || asRecord(asRecord(root.data).video_info) || root
  return asRecord(info.data) || info
}

function pickPlayItem(data: Record<string, unknown>): PlayItem | null {
  const list = asRecord(data.video_list)
  const values = list ? Object.values(list) : [data]
  let best: PlayItem | null = null
  for (const value of values) {
    const item = asRecord(value)
    const token = String(item.main_url || item.play_url || '').trim()
    if (!token) continue
    const width = Number(item.vwidth || item.width || 0)
    const height = Number(item.vheight || item.height || 0)
    const candidate: PlayItem = {
      token,
      fileHash: typeof item.file_hash === 'string' ? item.file_hash : null,
      size: Number(item.size || 0),
      quality: String(item.quality || item.definition || ''),
      pixels: width * height,
      bitrate: Number(item.real_bitrate || item.bitrate || 0)
    }
    if (!best || betterPlay(candidate, best)) best = candidate
  }
  return best
}

function betterPlay(next: PlayItem, prev: PlayItem): boolean {
  const nextOriginal = next.quality.toLowerCase() === 'original'
  const prevOriginal = prev.quality.toLowerCase() === 'original'
  if (nextOriginal !== prevOriginal) return nextOriginal
  if (next.pixels !== prev.pixels) return next.pixels > prev.pixels
  return next.bitrate > prev.bitrate
}

function pickSeed(root: unknown): string {
  const stack: unknown[] = [root]
  const seen = new Set<object>()
  let inspected = 0
  while (stack.length && inspected < 5000) {
    const value = stack.pop()
    if (!value || typeof value !== 'object') continue
    if (seen.has(value)) continue
    seen.add(value)
    inspected += 1
    const record = value as Record<string, unknown>
    if (typeof record.key_seed === 'string' && record.key_seed.trim()) {
      return record.key_seed.trim()
    }
    for (const child of Object.values(record)) {
      if (child && typeof child === 'object') stack.push(child)
    }
  }
  return ''
}

async function resolvePlayToken(token: string, seedRaw: string): Promise<string> {
  const direct = token.trim()
  if (direct.startsWith('https://')) return direct
  const data = base64ToBytes(token)
  if (!data) return ''
  const plain = textUrl(data)
  if (plain) return plain
  if (!token.startsWith('qAAB') || !seedRaw) return ''
  const seed = base64ToBytes(seedRaw)
  if (!seed) return ''
  const seed32 = seed.slice(0, 32)
  const round1 = new Uint8Array(await crypto.subtle.digest('SHA-512', seed32))
  const round2 = new Uint8Array(
    await crypto.subtle.digest('SHA-512', concatBytes(round1, matBytes()))
  )
  const partA = round2.slice(0, 16)
  const partB = round2.slice(16, 32)
  const tries: Array<{ payload: Uint8Array; key: Uint8Array; iv: Uint8Array }> = []
  if (data.length >= 4 && data[0] === 0xa8 && data[1] === 0 && data[2] === 1 && data[3] === 0) {
    tries.push({ payload: data.slice(4), key: partA, iv: partB })
    tries.push({ payload: data.slice(4), key: partB, iv: partA })
    if (data.length > 36) {
      tries.push({ payload: data.slice(36), key: partA, iv: data.slice(20, 36) })
      tries.push({ payload: data.slice(36), key: partA, iv: partB })
    }
  } else {
    tries.push({ payload: data, key: partA, iv: partB })
  }
  for (const item of tries) {
    const href = await decryptUrl(item.payload, item.key, item.iv)
    if (href) return href
  }
  return ''
}

async function decryptUrl(payload: Uint8Array, keyBytes: Uint8Array, iv: Uint8Array): Promise<string> {
  if (!payload.length || payload.length % 16 !== 0 || iv.length !== 16) return ''
  try {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt'])
    const plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, payload)
    )
    return textUrl(plain)
  } catch {
    return ''
  }
}

function textUrl(bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes).replace(/\0+$/g, '').trim()
  const start = text.indexOf('https://')
  if (start < 0) return ''
  return text.slice(start).split(/[\s"']/)[0]
}

function matBytes(): Uint8Array {
  return Uint8Array.from(PACKED_MAT, (n) => n ^ MAT_XOR)
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length)
  out.set(left, 0)
  out.set(right, left.length)
  return out
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    let normalized = value.trim().replace(/-/g, '+').replace(/_/g, '/')
    const pad = (4 - (normalized.length % 4)) % 4
    normalized += '='.repeat(pad)
    const binary = atob(normalized)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}
