import { afterEach, describe, expect, it, vi } from 'vitest'

import { MAX_IMAGE_EDGE, describeAttachment, prepareImageAttachment } from './imageAttachment'

function stubCanvas(dataUrl = 'data:image/jpeg;base64,aGVsbG8='): {
  drawImage: ReturnType<typeof vi.fn>
  fillRect: ReturnType<typeof vi.fn>
} {
  const drawImage = vi.fn()
  const fillRect = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillStyle: '',
    fillRect,
    drawImage
  } as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(dataUrl)
  return { drawImage, fillRect }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('prepareImageAttachment', () => {
  it('downscales the long edge and emits base64 jpeg', async () => {
    stubCanvas()
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4000, height: 2000 })))

    const draft = await prepareImageAttachment(
      new File(['x'], 'shot.png', { type: 'image/png' }),
      '截图 1'
    )

    expect(draft?.width).toBe(MAX_IMAGE_EDGE)
    expect(draft?.height).toBe(Math.round(2000 * (MAX_IMAGE_EDGE / 4000)))
    expect(draft?.attachment).toEqual({
      name: '截图 1',
      mediaType: 'image/jpeg',
      data: 'aGVsbG8='
    })
  })

  it('keeps a small image at its own size', async () => {
    stubCanvas()
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 64, height: 64 })))

    const draft = await prepareImageAttachment(
      new File(['x'], 'shot.png', { type: 'image/png' }),
      '截图 2'
    )

    expect(draft?.width).toBe(64)
    expect(draft?.height).toBe(64)
  })

  it('ignores non-image files and unreadable data', async () => {
    stubCanvas()
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 10, height: 10 })))

    expect(await prepareImageAttachment(new File(['x'], 'a.txt', { type: 'text/plain' }), 'x'))
      .toBeNull()
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('not-a-data-url')
    expect(await prepareImageAttachment(new File(['x'], 'a.png', { type: 'image/png' }), 'y'))
      .toBeNull()
  })
})

describe('describeAttachment', () => {
  it('shows dimensions and a readable size', () => {
    expect(describeAttachment({
      attachment: { name: '截图 1', mediaType: 'image/jpeg', data: 'x' },
      width: 1200,
      height: 800,
      bytes: 480 * 1024
    })).toBe('1200×800 · 480 KB')
  })
})
