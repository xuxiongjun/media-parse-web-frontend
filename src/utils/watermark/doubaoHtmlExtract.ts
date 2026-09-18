/** 从豆包等分享页「网页源代码」中提取无水印原图 URL（纯前端，不经后端）。 */

const MAX_IMAGES = 120

const IMAGE_ORI_RAW_URL =
  /"image_ori_raw"\s*:\s*\{\s*"url"\s*:\s*"(https[^"]+)"/gi
const IMAGE_ORI_RAW_BOUNDED =
  /image_ori_raw.{0,120}url.{0,60}"(https[^"]{10,1200})"/gi
const IMAGE_ORI_URL = /"image_ori"\s*:\s*\{\s*"url"\s*:\s*"(https[^"]+)"/gi
/** 兜底：直接抓带 image_raw / rc_gen_image 的字节图床链接 */
const LOOSE_RAW_URL =
  /https?:\/\/[a-z0-9.-]*(?:byteimg|ivolces|doubao)[^\s"'<>\\]{10,1200}/gi
const IMAGE_ID = /rc_gen_image\/([a-f0-9]{32})/i
const SHARE_NAME = /"share_name"\s*:\s*"([^"]{1,120})"/i
const UNICODE_ESCAPE = /\\u([0-9a-fA-F]{4})/g

export interface DoubaoHtmlExtractResult {
  urls: string[]
  title: string | null
}

export function extractDoubaoFromHtml(rawHtml: string): DoubaoHtmlExtractResult {
  const html = normalizeHtml(rawHtml)
  const byId = new Map<string, string>()

  collect(IMAGE_ORI_RAW_URL, html, byId, true)
  if (!byId.size) collect(IMAGE_ORI_RAW_BOUNDED, html, byId, true)
  if (!byId.size) collectLooseRaw(html, byId)
  if (!byId.size) collect(IMAGE_ORI_URL, html, byId, false)

  const urls: string[] = []
  for (const url of byId.values()) {
    const cleaned = cleanUrl(url)
    if (!cleaned || isLikelyThumb(cleaned)) continue
    urls.push(cleaned)
    if (urls.length >= MAX_IMAGES) break
  }

  return {
    urls,
    title: extractTitle(html)
  }
}

/**
 * 豆包「查看网页源代码」里，JSON 常被写成 &quot;...&quot;，
 * 必须先解码 HTML 实体，再解 JSON 转义，否则匹配不到 image_ori_raw。
 */
function normalizeHtml(raw: string): string {
  let t = raw
  // 1) HTML 实体（查看源码里最关键）
  t = t
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&#x2f;/gi, '/')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
  // 2) Unicode 转义 \u002F
  t = t.replace(UNICODE_ESCAPE, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16))
  )
  // 3) JSON 反斜杠转义
  for (let i = 0; i < 8; i++) {
    const nxt = t
      .replace(/\\"/g, '"')
      .replace(/\\\//g, '/')
      .replace(/\\\\/g, '\\')
    if (nxt === t) break
    t = nxt
  }
  return t
}

function collect(
  pattern: RegExp,
  html: string,
  out: Map<string, string>,
  preferRaw: boolean
) {
  pattern.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = pattern.exec(html)) !== null) {
    const raw = m[1]
    if (!raw?.trim()) continue
    if (preferRaw) {
      const lower = raw.toLowerCase()
      if (!(lower.includes('image_raw') || lower.includes('ori_raw'))) continue
    }
    const key = imageKey(raw)
    if (!out.has(key)) out.set(key, raw)
  }
}

function collectLooseRaw(html: string, out: Map<string, string>) {
  LOOSE_RAW_URL.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LOOSE_RAW_URL.exec(html)) !== null) {
    const raw = m[0]
    const lower = raw.toLowerCase()
    // 只要无水印原图；排除缩略图 / 水印版
    if (!(lower.includes('image_raw') || lower.includes('ori_raw'))) continue
    if (isLikelyThumb(raw)) continue
    const key = imageKey(raw)
    if (!out.has(key)) out.set(key, raw)
  }
}

function imageKey(url: string): string {
  const m = IMAGE_ID.exec(url)
  return m ? m[1].toLowerCase() : url.split('?')[0]
}

function cleanUrl(url: string): string | null {
  let u = url.trim()
  if (u.startsWith('//')) u = `https:${u}`
  if (!(u.startsWith('http://') || u.startsWith('https://'))) return null
  while (u.endsWith('\\') || u.endsWith(')') || u.endsWith(',') || u.endsWith(';')) {
    u = u.slice(0, -1)
  }
  const hash = u.indexOf('#')
  if (hash >= 0) u = u.slice(0, hash)
  u = u.replace(/&amp;/g, '&')
  return u
}

function isLikelyThumb(url: string): boolean {
  const lower = url.toLowerCase()
  return (
    lower.includes('downsize') ||
    lower.includes('image_thumb') ||
    lower.includes('_thumb') ||
    lower.includes('cthumb') ||
    lower.includes('cpreview') ||
    lower.includes('preview_sm') ||
    lower.includes('_wm1') ||
    lower.includes('_wm3') ||
    lower.includes('cdld_wm') ||
    (lower.includes('tplv-') && lower.includes('resize'))
  )
}

function extractTitle(html: string): string | null {
  const m = SHARE_NAME.exec(html)
  if (!m?.[1]) return null
  try {
    return JSON.parse(`"${m[1]}"`) as string
  } catch {
    return m[1]
  }
}
