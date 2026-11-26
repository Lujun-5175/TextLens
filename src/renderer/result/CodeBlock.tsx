import {
  isValidElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type JSX,
  type ReactNode
} from 'react'
import type { ExtraProps } from 'react-markdown'

type PreProps = ComponentPropsWithoutRef<'pre'> & ExtraProps

type CopyState = 'idle' | 'copied' | 'failed'

/** Long enough to read, short enough that the label never looks stuck. */
const COPY_FEEDBACK_MS = 1_500

const COPY_LABELS: Record<CopyState, string> = {
  idle: '复制代码',
  copied: '已复制',
  failed: '复制失败'
}

/**
 * Flattens React nodes back into plain text. Highlighting replaces the single
 * text child of `<code>` with dozens of `<span class="hljs-*">` elements, so a
 * shallow read of `children` would only ever copy the gaps between tokens.
 */
function textContentOf(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textContentOf).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return textContentOf(node.props.children)
  }
  return ''
}

/** Reads the text of the `<code>` child a fenced block always renders. */
function codeTextOf(children: ReactNode): string {
  const child = Array.isArray(children)
    ? children.find((entry) => isValidElement(entry))
    : children

  if (isValidElement<{ children?: ReactNode }>(child) && child.type === 'code') {
    return textContentOf(child.props.children)
  }

  return textContentOf(children)
}

/**
 * Replaces the default `<pre>` so every fenced code block gets a copy control.
 * The copy path is the result window's existing clipboard IPC; a rejected or
 * unavailable bridge is reported as failure instead of a fake success.
 */
export function MarkdownPre({ children, node: _node, ...rest }: PreProps): JSX.Element {
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const code = codeTextOf(children)

  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current)
    },
    []
  )

  const flash = useCallback((state: CopyState) => {
    if (resetTimer.current !== null) clearTimeout(resetTimer.current)
    setCopyState(state)
    resetTimer.current = setTimeout(() => {
      resetTimer.current = null
      setCopyState('idle')
    }, COPY_FEEDBACK_MS)
  }, [])

  const copy = useCallback(async () => {
    const bridge = window.textLens

    if (!bridge || typeof bridge.copyText !== 'function') {
      flash('failed')
      return
    }

    try {
      await bridge.copyText(code)
      flash('copied')
    } catch {
      // Never claim a copy that the clipboard write rejected.
      flash('failed')
    }
  }, [code, flash])

  return (
    <div className="markdown-code-block">
      <pre {...rest}>{children}</pre>
      <button
        type="button"
        className="markdown-code-block__copy"
        data-copy-state={copyState}
        aria-label={COPY_LABELS[copyState]}
        onClick={() => {
          void copy()
        }}
      >
        {COPY_LABELS[copyState]}
      </button>
    </div>
  )
}
