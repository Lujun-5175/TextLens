import { describe, expect, it } from 'vitest'

import { convertListMarkers, expandInlineFences, normalizeMarkdownSource } from './markdownNormalize'
import { contentLooksLikeMath } from './markdownPolicy'

describe('convertListMarkers', () => {
  it('maps Chinese ordered markers to GFM ordered lists', () => {
    expect(convertListMarkers('1、第一点')).toBe('1. 第一点')
    expect(convertListMarkers('2．第二点')).toBe('2. 第二点')
    expect(convertListMarkers('（3）第三点')).toBe('3. 第三点')
    expect(convertListMarkers('(4) fourth')).toBe('4. fourth')
  })

  it('maps decorative bullets to GFM unordered lists', () => {
    expect(convertListMarkers('• 条目')).toBe('- 条目')
    expect(convertListMarkers('· 条目')).toBe('- 条目')
    expect(convertListMarkers('● 条目')).toBe('- 条目')
  })

  it('leaves already-valid GFM list markers alone', () => {
    expect(convertListMarkers('- item')).toBe('- item')
    expect(convertListMarkers('1. item')).toBe('1. item')
    expect(convertListMarkers('  2) item')).toBe('  2) item')
  })
})

describe('normalizeMarkdownSource', () => {
  it('splits sentence-ended single newlines into paragraphs', () => {
    const input = '第一段完整内容。\n第二段完整内容。'
    expect(normalizeMarkdownSource(input)).toBe('第一段完整内容。\n\n第二段完整内容。')
  })

  it('keeps soft-wrapped mid-sentence lines as a single paragraph', () => {
    const input = 'This is a long English sentence that\ncontinues without terminal punctuation'
    expect(normalizeMarkdownSource(input)).toBe(input)
  })

  it('keeps tight sibling list items without blank lines between them', () => {
    const input = '前言说明。\n- 条目一\n- 条目二\n结尾说明。'
    expect(normalizeMarkdownSource(input)).toBe(
      '前言说明。\n\n- 条目一\n- 条目二\n\n结尾说明。'
    )
  })

  it('converts Chinese list markers and separates surrounding prose', () => {
    const input = '概要：\n1、准备材料\n2、开始翻译\n完成。'
    expect(normalizeMarkdownSource(input)).toBe(
      '概要：\n\n1. 准备材料\n2. 开始翻译\n\n完成。'
    )
  })

  it('restores a collapsed run of sentence-separated bullet items', () => {
    expect(normalizeMarkdownSource('第一项。 • 第二项。 • 第三项。')).toBe('- 第一项。\n- 第二项。\n- 第三项。')
    expect(normalizeMarkdownSource('• 第一项。 • 第二项。 • 第三项。')).toBe('- 第一项。\n- 第二项。\n- 第三项。')
    expect(normalizeMarkdownSource('只有一个。 • 符号')).toBe('只有一个。 • 符号')
    expect(normalizeMarkdownSource('```\n第一项。 • 第二项。 • 第三项。\n```')).toBe('```\n第一项。 • 第二项。 • 第三项。\n```')
    expect(normalizeMarkdownSource('`第一项。 • 第二项。 • 第三项。`')).toBe('`第一项。 • 第二项。 • 第三项。`')
  })

  it('does not rewrite content inside fenced code blocks', () => {
    const input = ['说明。', '```', '1、不要改', '第二行。', '```', '结束。'].join('\n')
    expect(normalizeMarkdownSource(input)).toBe(
      ['说明。', '', '```', '1、不要改', '第二行。', '```', '', '结束。'].join('\n')
    )
  })

  it.each([
    '```python\nprint("a\\nb\\nc\\nd\\ne")\n```',
    '`a\\nb\\nc` and `\\t`',
    '{"pattern":"\\n\\t","path":"C:\\new\\tools\\notes"}',
    '/\\n\\t\\w+/gu',
    '第一段。\\n\\n第二段。\\n- 条目'
  ])('preserves literal escapes in already decoded content: %s', (input) => {
    expect(normalizeMarkdownSource(input)).toBe(input)
  })

  it.each(['A title\n---', 'A title.\n===', 'A multi\nline title\n---'])('preserves Setext headings: %s', (input) => {
    expect(normalizeMarkdownSource(input)).toBe(input)
  })

  it('does not let a shorter fence close an enclosing code sample', () => {
    const input = ['````markdown', '```', '1、不要改', '正文。', '下一行。', '```', '````'].join('\n')
    expect(normalizeMarkdownSource(input)).toBe(input)
  })

  it('preserves nested lists and indented continuations', () => {
    const input = '- parent\n  continuation\n  - child\n    nested continuation\n- sibling'
    expect(normalizeMarkdownSource(input)).toBe(input)
  })

  it('separates headings and blockquotes from preceding prose', () => {
    const input = '上文。\n## 标题\n> 引用一行\n后文。'
    expect(normalizeMarkdownSource(input)).toBe(
      '上文。\n\n## 标题\n\n> 引用一行\n\n后文。'
    )
  })

  it('is a pure no-op for already-clean Markdown', () => {
    const input = ['# 标题', '', '段落一。', '', '- a', '- b', '', '段落二。'].join('\n')
    expect(normalizeMarkdownSource(input)).toBe(input)
  })
})

describe('inline fences', () => {
  it('moves a fence that starts mid-line onto its own line', () => {
    expect(expandInlineFences(['说明： ```python', 'print(1)', '```', '后文'])).toEqual([
      '说明：',
      '```python',
      'print(1)',
      '```',
      '后文'
    ])
  })

  it('expands a fence that opens and closes on one line', () => {
    expect(expandInlineFences(['说明： ```ts const a = 1 ``` 后文'])).toEqual([
      '说明：',
      '```ts',
      'const a = 1',
      '```',
      '后文'
    ])
  })

  it('leaves a fence at the start of a line alone', () => {
    const lines = ['```python', 'print(1)', '```']
    expect(expandInlineFences(lines)).toEqual(lines)
  })

  it('does not pair a stray mid-line fence with a later block', () => {
    // The later marker carries a language, so it opens a new block: the stray
    // one was never closed and splitting would swallow that block's body.
    const lines = ['用 ``` 包住代码', '', '正常段落', '', '```js', 'const a = 1', '```', '', '结尾']
    expect(expandInlineFences(lines)).toEqual(lines)
  })

  it('leaves the body of a real block untouched', () => {
    const lines = ['```md', '示例： ```json``` 这样写', '```']
    expect(expandInlineFences(lines)).toEqual(lines)
  })

  it('leaves a stray run of backticks alone when nothing closes it', () => {
    const lines = ['用 ``` 包住代码']
    expect(expandInlineFences(lines)).toEqual(lines)
  })
})

describe('LaTeX delimiters', () => {
  it('turns a multi-line bracket formula into a display block', () => {
    const input = [
      '样本 OLS 斜率可以写成：',
      '',
      String.raw`\[\hat\alpha_1`,
      String.raw`\frac{\sum_i (X_i-\bar X)(Y_i-\bar Y)} {\sum_i (X_i-\bar X)^2} \]`,
      '',
      '由大数定律和连续映射。'
    ].join('\n')
    const out = normalizeMarkdownSource(input)
    expect(out).toContain('$$')
    expect(out).toContain(String.raw`\hat\alpha_1`)
    expect(out).not.toContain(String.raw`\[`)
    expect(out).not.toContain(String.raw`\]`)
    expect(contentLooksLikeMath(out)).toBe(true)
  })

  it('keeps the formula body intact and never inserts blank lines inside it', () => {
    const out = normalizeMarkdownSource(String.raw`\[
a = b.

c = d
\]`)
    expect(out).toBe('$$\na = b.\nc = d\n$$')
  })

  it('converts single-line display and inline delimiters', () => {
    expect(normalizeMarkdownSource(String.raw`\[x=1\]`)).toBe('$$\nx=1\n$$')
    expect(normalizeMarkdownSource(String.raw`其中 \(\alpha=0.05\) 显著`)).toBe(
      String.raw`其中 $\alpha=0.05$ 显著`
    )
  })

  it('leaves fenced and inline code untouched', () => {
    const fenced = ['```tex', String.raw`\[x=1\]`, String.raw`\(y\)`, '```'].join('\n')
    expect(normalizeMarkdownSource(fenced)).toBe(fenced)
    expect(normalizeMarkdownSource(String.raw`用 ` + '`' + String.raw`\[x\]` + '`' + ' 表示显示公式')).toBe(
      String.raw`用 ` + '`' + String.raw`\[x\]` + '`' + ' 表示显示公式'
    )
  })

  it('escapes the dollars inside a span that mixes both delimiter styles', () => {
    // The model wrote `\(...\)` around an expression that already contained
    // `$`. Those dollars must not be allowed to pair with anything: doing so
    // let one broken formula swallow the rest of the answer.
    const input = String.raw`\(-\sum_t\left$(m_{it}'\right)$ + x\)`
    const out = normalizeMarkdownSource(input)
    expect(out).toContain(String.raw`\(-\sum_t\left`)
    expect(out).toContain(String.raw`\$(m_{it}'\right)\$`)
    expect(out).toContain(' + x')
  })

  it('escapes a dangling dollar so no span can reach the next block', () => {
    // remark-math pairs dollars by counting, so an odd one lets a formula
    // absorb whatever follows — including headings and code fences. Escaping
    // the leftover keeps pairing local; what the model meant by the other
    // dollars is none of our business, and KaTeX decides whether they parse.
    const out = normalizeMarkdownSource('前文 $ 这段不是公式 $N=80$ 和 $K=8$。')
    const unescaped = out.replace(/\\\$/gu, '').match(/\$/gu)?.length ?? 0
    expect(unescaped % 2).toBe(0)
    expect(out.endsWith('8\\$。')).toBe(true)
  })

  it('does not wrap a LaTeX span KaTeX rejects', () => {
    // `\frac{1}` is missing its second argument, so it can only ever render as
    // an error. Leaving the source alone shows TeX, not a red blob.
    const broken = String.raw`坏公式 \(\frac{1}\) 保留原文`
    expect(normalizeMarkdownSource(broken)).toBe(broken)
    expect(normalizeMarkdownSource(String.raw`好公式 \(x^2\)`)).toBe('好公式 $x^2$')
  })

  it('leaves dollar amounts inside code alone', () => {
    const input = ['```bash', "awk '{print $1, $2}'", '```', '', '价格 $5 到 $10。'].join('\n')
    const out = normalizeMarkdownSource(input)
    expect(out).toContain("awk '{print $1, $2}'")
  })

  it('keeps a clean inline formula untouched', () => {
    expect(normalizeMarkdownSource('在 $N=80$ 时误差约 $1.5\\times10^{-4}$。')).toBe(
      '在 $N=80$ 时误差约 $1.5\\times10^{-4}$。'
    )
  })

  it('keeps an unterminated opener instead of swallowing the rest', () => {
    const out = normalizeMarkdownSource(String.raw`\[x=1`)
    expect(out).toContain(String.raw`\[`)
    expect(out).toContain('x=1')
  })

  it('wraps bare parenthesised formulas that contain a LaTeX command', () => {
    expect(normalizeMarkdownSource(String.raw`代入 (Y=\beta_0+\beta_1X) 得`)).toBe(
      String.raw`代入 $(Y=\beta_0+\beta_1X)$ 得`
    )
    expect(normalizeMarkdownSource(String.raw`特别有 (E[\varepsilon\mid X,Z]=0)。于是`)).toBe(
      String.raw`特别有 $(E[\varepsilon\mid X,Z]=0)$。于是`
    )
  })

  it('leaves ordinary parentheses and existing math alone', () => {
    expect(normalizeMarkdownSource('这是（中文括号）和 (a+b) 的普通用法')).toBe(
      '这是（中文括号）和 (a+b) 的普通用法'
    )
    expect(normalizeMarkdownSource(String.raw`已有 $\frac{(a)}{b}$ 公式`)).toBe(
      String.raw`已有 $\frac{(a)}{b}$ 公式`
    )
    // Non-letter commands (paths, regex) must not trigger wrapping.
    expect(normalizeMarkdownSource(String.raw`路径 (C:\Users) 与正则 (\.\d+)`)).toBe(
      String.raw`路径 (C:\Users) 与正则 (\.\d+)`
    )
  })
})

describe('LaTeX inside existing math', () => {
  it('keeps a display block untouched, including row spacing', () => {
    const input = [
      '$$',
      String.raw`\begin{aligned}`,
      String.raw`a &= b \\[2pt]`,
      'c &= d',
      String.raw`\end{aligned}`,
      '$$',
      '',
      '后文。'
    ].join('\n')
    const out = normalizeMarkdownSource(input)
    // `\\[2pt]` is LaTeX row spacing, not a delimiter: it must survive verbatim.
    expect(out).toContain(String.raw`a &= b \\[2pt]`)
    expect(out.split('$$')).toHaveLength(3)
    expect(out).toContain(String.raw`\begin{aligned}`)
  })

  it('never turns a doubled backslash into an opener', () => {
    const input = String.raw`公式里换行 \\[2pt] 是行距`
    expect(normalizeMarkdownSource(input)).toBe(input)
  })
})

describe('currency dollars', () => {
  it('escapes a money pair so remark-math cannot swallow it', () => {
    const out = normalizeMarkdownSource('价格是 $5，折扣 $10 元')
    expect(out).toContain(String.raw`\$5`)
    expect(out).toContain(String.raw`\$10`)
  })

  it('leaves real inline math alone', () => {
    const input = '公式 $x^2$ 成立'
    expect(normalizeMarkdownSource(input)).toBe(input)
  })
})
