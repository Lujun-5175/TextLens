import { memo, useMemo, type JSX } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

import 'katex/dist/katex.min.css'

import { isSafeExternalUrl } from '../../shared'
import { MarkdownPre } from './CodeBlock'
import { contentLooksLikeMath } from './markdownPolicy'
import { normalizeMarkdownSource } from './markdownNormalize'

export interface SafeMarkdownProps {
  content: string
  onOpenExternal(url: string): void
}

type RehypePlugins = NonNullable<React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']>

// Stable plugin identity so react-markdown can skip re-setup when only text changes.
const REMARK_GFM_ONLY = [remarkGfm]
const REMARK_WITH_MATH = [remarkGfm, remarkMath]

const KATEX_OPTIONS = {
  output: 'htmlAndMathml',
  strict: 'ignore',
  // A malformed formula must degrade to visible source, not throw and blank
  // the whole answer while streaming.
  throwOnError: false,
  errorColor: '#f87171',
  trust: false,
  maxSize: 20,
  maxExpand: 1_000
} as const

// `common` (the rehype-highlight default) covers ~37 everyday grammars.
// `detect: false` keeps unlabelled fences plain: guessing a language from log
// or prose lines paints them wrong. rehype-highlight 7 always tolerates a
// language it has no grammar for (it warns on the vfile and leaves the code
// text alone), which is what the old `ignoreMissing: true` bought.
const HIGHLIGHT_OPTIONS = { detect: false } as const

// Stable plugin identity so react-markdown can skip re-setup when only text
// changes. KaTeX runs first so display formulas are gone before the highlighter
// walks the tree and cannot be mistaken for a `language-math` code block.
const REHYPE_HIGHLIGHT_ONLY: RehypePlugins = [[rehypeHighlight, HIGHLIGHT_OPTIONS]]
const REHYPE_KATEX_AND_HIGHLIGHT: RehypePlugins = [
  [rehypeKatex, KATEX_OPTIONS],
  [rehypeHighlight, HIGHLIGHT_OPTIONS]
]

type MarkdownComponents = NonNullable<React.ComponentProps<typeof ReactMarkdown>['components']>

function createMarkdownComponents(onOpenExternal: (url: string) => void): MarkdownComponents {
  return {
    a: ({ href, children }) =>
      href && isSafeExternalUrl(href) ? (
        <a
          href={href}
          rel="noreferrer noopener"
          onClick={(event) => {
            event.preventDefault()
            if (
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            ) {
              return
            }
            onOpenExternal(href)
          }}
          onAuxClick={(event) => {
            event.preventDefault()
          }}
        >
          {children}
        </a>
      ) : (
        <span>{children}</span>
      ),
    img: ({ alt }) => <span>{alt ? `[图片：${alt}]` : '[图片]'}</span>,
    // Fenced blocks are the only nodes that reach `<pre>`; the override only
    // adds the copy affordance, the security-relevant nodes above are untouched.
    pre: MarkdownPre
  }
}

/**
 * Renders model output without raw HTML or automatic remote image requests.
 * Links are handed to the main process only after an explicit HTTP(S) check.
 * KaTeX plugins run only when content looks like math (conservative heuristic).
 *
 * Source is normalized once (memoized) so translation paragraphs / Chinese
 * list markers survive CommonMark's single-newline collapsing.
 */
function SafeMarkdownView({ content, onOpenExternal }: SafeMarkdownProps): JSX.Element {
  const normalized = useMemo(() => normalizeMarkdownSource(content), [content])
  const enableMath = useMemo(() => contentLooksLikeMath(normalized), [normalized])
  const components = useMemo(
    () => createMarkdownComponents(onOpenExternal),
    [onOpenExternal]
  )

  return (
    <ReactMarkdown
      skipHtml
      remarkPlugins={enableMath ? REMARK_WITH_MATH : REMARK_GFM_ONLY}
      rehypePlugins={enableMath ? REHYPE_KATEX_AND_HIGHLIGHT : REHYPE_HIGHLIGHT_ONLY}
      components={components}
    >
      {normalized}
    </ReactMarkdown>
  )
}

export const SafeMarkdown = memo(SafeMarkdownView)
