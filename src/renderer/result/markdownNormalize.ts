/**
 * Lightweight Markdown source cleanup for model/translation output.
 *
 * CommonMark collapses single newlines inside paragraphs to spaces, so
 * translations that use one `\n` between paragraphs or Chinese-style list
 * markers (1、 / •) often render as a single blob. This pass repairs structure
 * outside fenced code without a full re-parse, keeping O(n) cost.
 */

const FENCE_MARKER = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/u
const ATX_HEADING = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/u
const BLOCKQUOTE = /^[ \t]{0,3}>/u
const TABLE_ROW = /^[ \t]{0,3}\|/u
const HORIZONTAL_RULE = /^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/u
const SETEXT_UNDERLINE = /^[ \t]{0,3}(?:=+|-+)[ \t]*$/u
/** GFM / CommonMark list markers, plus common Chinese translation markers. */
const LIST_LINE =
  /^[ \t]{0,3}(?:[-*+•·●○](?:[ \t]+|$)|(?:\d{1,3}(?:[.)]|、|．)|[（(]\d{1,3}[）)])(?:[ \t]+|$))/u
const ORDERED_CN = /^([ \t]{0,3})(\d{1,3})([、．])([ \t]*)(.*)$/u
const ORDERED_PAREN = /^([ \t]{0,3})[（(](\d{1,3})[）)]([ \t]*)(.*)$/u
const UNORDERED_BULLET = /^([ \t]{0,3})([•·●○])([ \t]+)(.*)$/u
/** Sentence-like endings used to decide when a single newline is a paragraph break. */
const SENTENCE_END = /(?:[.!?…。！？；;]|\u2026)["'”’」』》）)\]]*$/u

// Some providers collapse list items into one line while keeping bullet glyphs.
// Require multiple sentence-ending boundaries to avoid rewriting ordinary prose.
// A capture group replaces the lookbehind this used to need: the build targets
// Safari 15, whose WebKit throws on lookbehind and would blank the whole window.
const INLINE_BULLET_BOUNDARY = /([。！？.!?])\s+[•·●○]\s+/gu

export function hasCollapsedBulletList(line: string): boolean {
  if (/[`$|]/u.test(line) || /^[ \t]*(?:[#>*+\-]|\d+[.)])/u.test(line)) return false
  return (line.match(INLINE_BULLET_BOUNDARY)?.length ?? 0) >= 2
}

function expandCollapsedBulletList(line: string): string {
  if (!hasCollapsedBulletList(line)) return line
  return '- ' + line.replace(/^[ \t]*[•·●○]\s+/u, '').replace(INLINE_BULLET_BOUNDARY, '$1\n- ')
}

type LineKind = 'blank' | 'list' | 'table' | 'heading' | 'quote' | 'hr' | 'fence' | 'math' | 'prose'

const INLINE_CODE = /(`+)[^`]*?\1/gu
const LATEX_INLINE = /\\\(([^\n]*?)\\\)/gu
const LATEX_COMMAND = /\\[a-z]{2,}/u
const BARE_PAREN = /\(([^()\n]{1,200})\)/gu

/** Ranges covered by inline code so rewrites never touch code samples. */
function inlineCodeSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  for (const match of line.matchAll(INLINE_CODE)) {
    spans.push([match.index, match.index + match[0].length])
  }
  return spans
}

function mapOutsideInlineCode(line: string, map: (segment: string) => string): string {
  const spans = inlineCodeSpans(line)
  if (spans.length === 0) return map(line)
  let result = ''
  let cursor = 0
  for (const [start, end] of spans) {
    result += map(line.slice(cursor, start))
    result += line.slice(start, end)
    cursor = end
  }
  return result + map(line.slice(cursor))
}

function indexOutsideInlineCode(line: string, needle: string, from = 0): number {
  const spans = inlineCodeSpans(line)
  let index = line.indexOf(needle, from)
  while (index !== -1) {
    const inCode = spans.some(([start, end]) => index >= start && index < end)
    // A doubled backslash is LaTeX's own line break (`\\[2pt]`), not a
    // delimiter: the two-character needle would otherwise match its tail.
    const escaped = index > 0 && line[index - 1] === '\\'
    if (!inCode && !escaped) return index
    index = line.indexOf(needle, index + 1)
  }
  return -1
}

/**
 * Map LaTeX's own math delimiters onto the `$` forms remark-math understands.
 *
 * Models routinely emit `\[ ... \]` / `\( ... \)`, which CommonMark would
 * escape into literal brackets. Fenced code and inline code keep their literal
 * content so LaTeX sources shown as code stay intact.
 */
export function normalizeLatexDelimiters(source: string): string {
  if (!source || !source.includes('\\')) return source
  const out: string[] = []
  let fenceChar: string | null = null
  let fenceLength = 0
  let display: string[] | null = null
  // `$$` blocks are already valid math: leave their contents alone so aligned
  // environments keep their `\\[2pt]` row spacing.
  let dollarBlock = false

  const flushDisplay = (): void => {
    if (display === null) return
    // Blank lines inside a display formula only add noise for KaTeX.
    const body = display.filter((line) => line.trim() !== '')
    out.push('$$')
    for (const line of body) out.push(line)
    out.push('$$')
    display = null
  }

  for (const raw of source.replace(/\r\n?/gu, '\n').split('\n')) {
    if (fenceChar !== null) {
      out.push(raw)
      if (isMatchingFenceClose(raw, fenceChar, fenceLength)) fenceChar = null
      continue
    }
    const fenceMatch = raw.match(FENCE_MARKER)
    if (fenceMatch && !(fenceMatch[1]![0] === '`' && fenceMatch[2]!.includes('`'))) {
      flushDisplay()
      fenceChar = fenceMatch[1]![0]!
      fenceLength = fenceMatch[1]!.length
      out.push(raw)
      continue
    }

    if (dollarBlock) {
      out.push(raw)
      if (raw.trim() === '$$') dollarBlock = false
      continue
    }
    if (raw.trim() === '$$') {
      out.push(raw)
      dollarBlock = true
      continue
    }

    if (display !== null) {
      const closed = indexOutsideInlineCode(raw, '\\]')
      if (closed === -1) {
        display.push(raw)
        continue
      }
      display.push(raw.slice(0, closed))
      flushDisplay()
      const rest = rewriteInlineLine(raw.slice(closed + 2))
      if (rest.length > 0) out.push(rest)
      continue
    }

    const open = indexOutsideInlineCode(raw, '\\[')
    if (open === -1) {
      out.push(rewriteInlineLine(raw))
      continue
    }
    const head = rewriteInlineLine(raw.slice(0, open))
    if (head.length > 0) out.push(head)
    const close = indexOutsideInlineCode(raw, '\\]', open + 2)
    if (close === -1) {
      const seed = rewriteInlineLine(raw.slice(open + 2))
      display = seed.length > 0 ? [seed] : []
    } else {
      const body = rewriteInlineLine(raw.slice(open + 2, close)).trim()
      if (body.length > 0) out.push(`$$${body}$$`)
      const tail = rewriteInlineLine(raw.slice(close + 2))
      if (tail.length > 0) out.push(tail)
    }
  }

  // Unterminated opener: keep the original text instead of eating the rest.
  if (display !== null) {
    out.push('\\[')
    for (const line of display) out.push(line)
  }
  return out.join('\n')
}

/** Apply every inline rewrite outside inline code spans. */
function rewriteInlineLine(line: string): string {
  return wrapBareParenMath(rewriteInlineMath(line))
}

/** Rewrite `\( ... \)` outside inline code spans. */
function rewriteInlineMath(line: string): string {
  if (!line.includes('\\(')) return line
  return mapOutsideInlineCode(line, (segment) =>
    segment.replace(LATEX_INLINE, (_all, body: string) => {
      const trimmed = body.trim()
      return trimmed.length > 0 ? `$${trimmed}$` : '$$'
    })
  )
}

/**
 * Models often write inline formulas as a bare parenthesised run, e.g.
 * `(Y=\beta_0+\beta_1X)`. Wrap those in `$...$` so KaTeX renders them.
 *
 * Deliberately narrow: the body must contain a real LaTeX command, stay on one
 * line, sit outside inline code and outside existing math. Multi-line or
 * already-correct output is never rewritten.
 */
export function wrapBareParenMath(line: string): string {
  if (!line.includes('\\')) return line
  return mapOutsideInlineCode(line, (segment) =>
    mapOutsideDollarMath(segment, (text) =>
      text.replace(BARE_PAREN, (all, body: string) =>
        // Keep the parentheses inside the formula: `(a+b)` is content, not
        // grouping for the delimiters.
        LATEX_COMMAND.test(body) && !body.includes('$') ? `$${all}$` : all
      )
    )
  )
}

/** Apply `map` only to runs outside `$...$` / `$$...$$`. */
function mapOutsideDollarMath(line: string, map: (text: string) => string): string {
  let result = ''
  let cursor = 0
  let index = 0
  while (index < line.length) {
    if (line[index] !== '$') {
      index += 1
      continue
    }
    let run = 0
    while (line[index + run] === '$') run += 1
    const fence = '$'.repeat(run)
    const close = line.indexOf(fence, index + run)
    if (close === -1) break
    result += map(line.slice(cursor, index))
    result += line.slice(index, close + run)
    cursor = close + run
    index = cursor
  }
  return result + map(line.slice(cursor))
}

const CURRENCY_PAIR = /\$(\d[^$\n]*?)\$/gu
const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u

/**
 * `$5 ... $10` is money, not inline math: remark-math would swallow both
 * dollars and typeset the span between them. Escape the pair when the body
 * reads like prose (CJK characters, or a trailing space before the closing
 * dollar); real formulas such as `$x^2$` keep working.
 */
export function escapeCurrencyDollars(line: string): string {
  if (!line.includes('$')) return line
  return line.replace(CURRENCY_PAIR, (match, body: string) => {
    const looksLikeMoney = CJK.test(body) || /\s$/u.test(body)
    return looksLikeMoney ? match.replace(/\$/gu, '\\$') : match
  })
}

export function normalizeMarkdownSource(source: string): string {
  if (!source) return source

  // The transport has already decoded JSON. Literal escapes are content,
  // especially inside code, regular expressions and Windows paths.
  const text = normalizeLatexDelimiters(source)
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map(escapeCurrencyDollars)
    .join('\n')
  const lines = text.split('\n')
  const out: string[] = []
  let fenceChar: string | null = null
  let fenceLength = 0
  let mathBlock = false
  let previousKind: LineKind = 'blank'
  let previousLine = ''

  const emitBlank = (): void => {
    if (out.length === 0 || previousKind === 'blank') return
    out.push('')
    previousKind = 'blank'
    previousLine = ''
  }

  const emitLine = (line: string, kind: LineKind): void => {
    out.push(line)
    previousKind = kind
    previousLine = line
  }

  for (const raw of lines) {
    if (fenceChar !== null) {
      emitLine(raw, 'fence')
      if (isMatchingFenceClose(raw, fenceChar, fenceLength)) {
        fenceChar = null
      }
      continue
    }

    const fenceMatch = raw.match(FENCE_MARKER)
    if (fenceMatch && !(fenceMatch[1]![0] === '`' && fenceMatch[2]!.includes('`'))) {
      // Outside a fence any fence marker opens (``` / ```ts / ~~~).
      if (previousKind !== 'blank') emitBlank()
      fenceChar = fenceMatch[1]![0]!
      fenceLength = fenceMatch[1]!.length
      emitLine(raw, 'fence')
      continue
    }

    if (raw.trim().length === 0) {
      emitBlank()
      continue
    }

    // A `$$` block is a single unit: never insert paragraph breaks, list
    // rewrites or bullet expansion inside it.
    if (raw.trim() === '$$') {
      if (mathBlock) {
        emitLine(raw, 'math')
        mathBlock = false
        continue
      }
      if (previousKind !== 'blank') emitBlank()
      emitLine(raw, 'math')
      mathBlock = true
      continue
    }
    if (mathBlock) {
      emitLine(raw, 'math')
      continue
    }

    // A Setext underline belongs to the preceding paragraph. Separating it
    // would turn an h1/h2 into ordinary prose and a horizontal rule.
    const priorKind = previousKind as LineKind
    if (priorKind === 'prose' && SETEXT_UNDERLINE.test(raw)) {
      emitLine(raw, 'heading')
      continue
    }

    const expanded = expandCollapsedBulletList(raw)
    if (expanded !== raw) {
      if (previousKind !== 'blank') emitBlank()
      for (const item of expanded.split('\n')) emitLine(item, 'list')
      continue
    }
    const line = convertListMarkers(raw)
    const kind = priorKind === 'list' && /^[ \t]{2,}\S/u.test(line)
      ? 'list'
      : classifyLine(line)

    if (previousKind !== 'blank' && shouldSeparate(previousKind, kind, previousLine, line)) {
      emitBlank()
    }

    emitLine(line, kind)
  }

  while (out.length > 0 && out[0] === '') out.shift()
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

function classifyLine(line: string): LineKind {
  if (LIST_LINE.test(line)) return 'list'
  if (TABLE_ROW.test(line)) return 'table'
  if (ATX_HEADING.test(line)) return 'heading'
  if (BLOCKQUOTE.test(line)) return 'quote'
  if (HORIZONTAL_RULE.test(line)) return 'hr'
  return 'prose'
}

/**
 * Keep tight runs of the same structural kind (list items, table rows, quote
 * lines). Insert a blank line on every other block transition, and between
 * prose lines that look like finished sentences / paragraphs.
 */
function shouldSeparate(
  previous: LineKind,
  next: LineKind,
  previousLine: string,
  nextLine: string
): boolean {
  if (previous === next && (previous === 'list' || previous === 'table' || previous === 'quote')) {
    return false
  }
  if (previous !== 'prose' || next !== 'prose') {
    return true
  }
  return looksLikeParagraphBreak(previousLine, nextLine)
}

function isMatchingFenceClose(line: string, fenceChar: string, fenceLength: number): boolean {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/u)
  if (!match) return false
  const marker = match[1]!
  return marker[0] === fenceChar && marker.length >= fenceLength
}

/**
 * Map Chinese / decorative list markers to GFM so remark-gfm can render them.
 * Leaves already-valid `- ` / `1. ` lines untouched.
 */
export function convertListMarkers(line: string): string {
  const unordered = line.match(UNORDERED_BULLET)
  if (unordered) {
    return `${unordered[1]}- ${unordered[4] ?? ''}`
  }

  const orderedCn = line.match(ORDERED_CN)
  if (orderedCn) {
    const space = orderedCn[4] && orderedCn[4].length > 0 ? orderedCn[4] : ' '
    return `${orderedCn[1]}${orderedCn[2]}.${space}${orderedCn[5] ?? ''}`
  }

  const orderedParen = line.match(ORDERED_PAREN)
  if (orderedParen) {
    const space = orderedParen[3] && orderedParen[3].length > 0 ? orderedParen[3] : ' '
    return `${orderedParen[1]}${orderedParen[2]}.${space}${orderedParen[4] ?? ''}`
  }

  return line
}

function looksLikeParagraphBreak(previousLine: string, nextLine: string): boolean {
  const previous = previousLine.trimEnd()
  const next = nextLine.trimStart()
  if (!previous || !next) return false
  // Soft-wrapped English mid-sentence: keep as a single paragraph.
  if (!SENTENCE_END.test(previous)) return false
  // Do not split before indented continuations (code / nested list).
  if (/^[ \t]{2,}\S/u.test(nextLine)) return false
  return true
}
