import type { ChatImageAttachment } from '../../shared'

/** More than this and every follow-up turn becomes expensive to replay. */
export const MAX_ATTACHMENTS = 4
/** Long edge of the compressed image, the usual sweet spot for vision models. */
export const MAX_IMAGE_EDGE = 1568
const JPEG_QUALITY = 0.85

export interface AttachmentDraft {
  attachment: ChatImageAttachment
  width: number
  height: number
  /** Approximate decoded size, for the chip tooltip. */
  bytes: number
}

/**
 * Turns a pasted clipboard image into an attachment the backend accepts:
 * downscaled to a bounded long edge, re-encoded as JPEG, base64 without the
 * data-URL prefix. The original screenshot never leaves the machine.
 */
export async function prepareImageAttachment(
  file: File,
  name: string
): Promise<AttachmentDraft | null> {
  if (!file.type.startsWith('image/')) return null
  const bitmap = await loadBitmap(file)
  if (!bitmap) return null
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return null
  // JPEG has no alpha channel; paint white first so a transparent screenshot
  // does not turn black.
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.drawImage(bitmap, 0, 0, width, height)
  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  const data = dataUrl.slice(comma + 1)
  if (!data) return null
  return {
    attachment: { name, mediaType: 'image/jpeg', data },
    width,
    height,
    bytes: Math.round((data.length * 3) / 4)
  }
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file)
    } catch {
      // Fall through to the <img> path; WebView2 normally has the bitmap API.
    }
  }
  const url = URL.createObjectURL(file)
  return await new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    image.src = url
  })
}

/** `1200×800 · 480 KB` for the chip tooltip. */
export function describeAttachment(draft: AttachmentDraft): string {
  const size = draft.bytes >= 1024 * 1024
    ? `${(draft.bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(draft.bytes / 1024))} KB`
  return `${draft.width}×${draft.height} · ${size}`
}
