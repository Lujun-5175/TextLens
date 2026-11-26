import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SafeMarkdown } from './SafeMarkdown'

function stubClipboard(copyText: (text: string) => Promise<void>): void {
  Object.defineProperty(window, 'textLens', {
    value: { copyText },
    configurable: true,
    writable: true
  })
}

afterEach(() => {
  Reflect.deleteProperty(window, 'textLens')
})

describe('SafeMarkdown', () => {
  it('does not create executable DOM nodes from raw HTML', () => {
    const { container } = render(
      <SafeMarkdown
        content={'正常文本\n\n<script>window.pwned = true</script>\n<img src="x" onerror="window.pwned = true">'}
        onOpenExternal={() => undefined}
      />
    )

    expect(screen.getByText('正常文本')).toBeInTheDocument()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[onerror]')).toBeNull()
  })

  it('renders dangerous links as inert text', () => {
    const onOpenExternal = vi.fn()
    const { container } = render(
      <SafeMarkdown
        content={'[脚本](javascript:alert(1)) [数据](data:text/html,pwned)'}
        onOpenExternal={onOpenExternal}
      />
    )

    expect(screen.getByText('脚本')).toBeInTheDocument()
    expect(screen.getByText('数据')).toBeInTheDocument()
    expect(container.querySelector('a')).toBeNull()
    expect(onOpenExternal).not.toHaveBeenCalled()
  })

  it('routes an HTTP(S) link through the provided opener', () => {
    const onOpenExternal = vi.fn()
    render(
      <SafeMarkdown content={'[官网](https://example.com/path?q=1)'} onOpenExternal={onOpenExternal} />
    )

    const link = screen.getByRole('link', { name: '官网' })
    fireEvent.click(link)

    expect(onOpenExternal).toHaveBeenCalledOnce()
    expect(onOpenExternal).toHaveBeenCalledWith('https://example.com/path?q=1')
  })

  it('ignores middle-click and does not open external links', () => {
    const onOpenExternal = vi.fn()
    render(
      <SafeMarkdown content={'[官网](https://example.com/path?q=1)'} onOpenExternal={onOpenExternal} />
    )

    const link = screen.getByRole('link', { name: '官网' })
    const clickEvent = fireEvent.click(link, { button: 1 })
    const auxEvent = fireEvent(
      link,
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    )

    expect(clickEvent).toBe(false)
    expect(auxEvent).toBe(false)
    expect(onOpenExternal).not.toHaveBeenCalled()
  })

  it('ignores primary clicks with modifier keys', () => {
    const onOpenExternal = vi.fn()
    render(
      <SafeMarkdown content={'[官网](https://example.com/path?q=1)'} onOpenExternal={onOpenExternal} />
    )

    const link = screen.getByRole('link', { name: '官网' })

    for (const modifiers of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true }
    ]) {
      const prevented = fireEvent.click(link, { button: 0, ...modifiers })
      expect(prevented).toBe(false)
    }

    expect(onOpenExternal).not.toHaveBeenCalled()
  })

  it('does not load remote Markdown images', () => {
    const { container } = render(
      <SafeMarkdown content={'![追踪像素](https://example.com/pixel.gif)'} onOpenExternal={() => undefined} />
    )

    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('[图片：追踪像素]')).toBeInTheDocument()
  })

  it('renders GitHub-flavored Markdown tables and task lists', () => {
    const { container } = render(
      <SafeMarkdown
        content={'| 项目 | 状态 |\n| --- | --- |\n| 翻译 | 完成 |\n\n- [x] 支持 Markdown'}
        onOpenExternal={() => undefined}
      />
    )

    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: '项目' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '完成' })).toBeInTheDocument()
    expect(container.querySelector('input[type="checkbox"]')).toBeDisabled()
  })

  it('renders headings, ordered and unordered lists, blockquotes and fenced code', () => {
    const { container } = render(
      <SafeMarkdown
        content={[
          '# 一级标题',
          '',
          '1. 有序项目',
          '',
          '- 无序项目',
          '',
          '> 引用段落',
          '',
          '行内 `const value = 1`',
          '',
          '```ts',
          'const answer = 42',
          '```'
        ].join('\n')}
        onOpenExternal={() => undefined}
      />
    )

    expect(screen.getByRole('heading', { name: '一级标题', level: 1 })).toBeInTheDocument()
    expect(screen.getByText('有序项目').closest('ol')).toBeInTheDocument()
    expect(screen.getByText('无序项目').closest('ul')).toBeInTheDocument()
    expect(screen.getByText('引用段落').closest('blockquote')).toBeInTheDocument()
    expect(screen.getByText('const value = 1').tagName).toBe('CODE')
    // Highlighting splits the fence into token spans, so the block text is
    // asserted on the <pre> instead of a single text node.
    expect(container.querySelector('pre')?.textContent).toContain('const answer = 42')
  })

  it('preserves translation paragraphs separated by a single newline', () => {
    const { container } = render(
      <SafeMarkdown
        content={'第一段完整内容。\n第二段完整内容。\n\n**强调** 后仍分段。'}
        onOpenExternal={() => undefined}
      />
    )

    const paragraphs = container.querySelectorAll('p')
    expect(paragraphs.length).toBeGreaterThanOrEqual(2)
    expect(paragraphs[0]?.textContent).toContain('第一段完整内容。')
    expect(paragraphs[1]?.textContent).toContain('第二段完整内容。')
  })

  it('renders collapsed translation bullets as separate list items', () => {
    render(<SafeMarkdown content="改进了重试。 • 提高了可靠性。 • 防止了操作执行。" onOpenExternal={() => undefined} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getByText('提高了可靠性。')).toBeInTheDocument()
  })

  it('renders Chinese-style list markers as real lists', () => {
    const { container } = render(
      <SafeMarkdown
        content={'概要：\n1、准备材料\n2、开始翻译\n• 补充说明'}
        onOpenExternal={() => undefined}
      />
    )

    expect(screen.getByText('准备材料').closest('ol')).toBeInTheDocument()
    expect(screen.getByText('开始翻译').closest('ol')).toBeInTheDocument()
    expect(screen.getByText('补充说明').closest('ul')).toBeInTheDocument()
    // Prose before the list stays its own block, not glued into the first item.
    expect(container.querySelector('p')?.textContent).toContain('概要')
  })

  it('renders non-math GFM without KaTeX nodes', () => {
    const { container } = render(
      <SafeMarkdown
        content={[
          '# 总结',
          '',
          '- 要点一',
          '- 要点二',
          '',
          '```ts',
          'const ok = true',
          '```'
        ].join('\n')}
        onOpenExternal={() => undefined}
      />
    )

    expect(screen.getByRole('heading', { name: '总结', level: 1 })).toBeInTheDocument()
    expect(screen.getByText('要点一').closest('ul')).toBeInTheDocument()
    expect(container.querySelector('pre')?.textContent).toContain('const ok = true')
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.querySelector('math')).toBeNull()
  })

  it('renders inline and display Markdown formulas with accessible KaTeX output', () => {
    const { container } = render(
      <SafeMarkdown
        content={'欧拉公式 $e^{i\\pi}+1=0$。\n\n$$\n\\int_0^1 x^2\\,dx=\\frac{1}{3}\n$$'}
        onOpenExternal={() => undefined}
      />
    )

    expect(container.querySelectorAll('.katex')).toHaveLength(2)
    expect(container.querySelector('.katex-display')).toBeInTheDocument()
    expect(container.querySelectorAll('math[xmlns="http://www.w3.org/1998/Math/MathML"]'))
      .toHaveLength(2)
  })

  it('keeps untrusted formula commands from creating links or remote resources', () => {
    const { container } = render(
      <SafeMarkdown
        content={'$\\href{javascript:alert(1)}{危险链接}$\n\n$$\\includegraphics{https://example.com/a.png}$$'}
        onOpenExternal={() => undefined}
      />
    )

    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.katex')).toBeInTheDocument()
  })

  it('highlights fenced code that declares a language', () => {
    const { container } = render(
      <SafeMarkdown content={'```ts\nconst answer = 42\n```'} onOpenExternal={() => undefined} />
    )

    const code = container.querySelector('pre > code')
    expect(code).toHaveClass('hljs')
    expect(code).toHaveClass('language-ts')
    expect(container.querySelector('.hljs-keyword')).toHaveTextContent('const')
    expect(container.querySelector('.hljs-number')).toHaveTextContent('42')
    expect(container.querySelector('pre')?.textContent).toContain('const answer = 42')
  })

  it('leaves an unlabelled fence unhighlighted instead of guessing a language', () => {
    const { container } = render(
      <SafeMarkdown
        content={'```\nconst answer = 42\n2026-01-02 INFO ready\n```'}
        onOpenExternal={() => undefined}
      />
    )

    expect(container.querySelector('.hljs')).toBeNull()
    expect(container.querySelector('[class*="hljs-"]')).toBeNull()
    expect(container.querySelector('pre')?.textContent).toContain('2026-01-02 INFO ready')
  })

  it('leaves an unregistered language as plain code without failing the render', () => {
    const { container } = render(
      <SafeMarkdown content={'```brainfuck\n+++[>+<-]\n```'} onOpenExternal={() => undefined} />
    )

    expect(container.querySelector('[class*="hljs-"]')).toBeNull()
    expect(container.querySelector('pre')?.textContent).toContain('+++[>+<-]')
  })

  it('keeps KaTeX formulas out of the highlighter', () => {
    const { container } = render(
      <SafeMarkdown
        content={'$$\n\\int_0^1 x^2\\,dx=\\frac{1}{3}\n$$\n\n```ts\nconst answer = 42\n```'}
        onOpenExternal={() => undefined}
      />
    )

    expect(container.querySelector('.katex-display')).toBeInTheDocument()
    expect(container.querySelector('.katex .hljs')).toBeNull()
    expect(container.querySelectorAll('pre > code.hljs')).toHaveLength(1)
  })

  it('copies the raw text of a fenced block through the clipboard bridge', async () => {
    const copyText = vi.fn<(text: string) => Promise<void>>(async () => undefined)
    stubClipboard(copyText)

    render(
      <SafeMarkdown
        content={'```ts\nconst first = 1\nconst second = 2\n```'}
        onOpenExternal={() => undefined}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '复制代码' }))

    await waitFor(() => expect(copyText).toHaveBeenCalledTimes(1))
    expect(copyText).toHaveBeenCalledWith('const first = 1\nconst second = 2\n')
  })

  it('reports a successful copy in the button label', async () => {
    stubClipboard(async () => undefined)

    render(
      <SafeMarkdown content={'```js\nconsole.log(1)\n```'} onOpenExternal={() => undefined} />
    )

    fireEvent.click(screen.getByRole('button', { name: '复制代码' }))

    expect(await screen.findByRole('button', { name: '已复制' })).toBeInTheDocument()
  })

  it('does not claim success when the clipboard write fails', async () => {
    stubClipboard(async () => {
      throw new Error('ipc unavailable')
    })

    render(
      <SafeMarkdown content={'```js\nconsole.log(1)\n```'} onOpenExternal={() => undefined} />
    )

    fireEvent.click(screen.getByRole('button', { name: '复制代码' }))

    expect(await screen.findByRole('button', { name: '复制失败' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '已复制' })).toBeNull()
  })

  it('gives every fenced block one copy control and leaves inline code alone', () => {
    render(
      <SafeMarkdown
        content={'行内 `npm run dev`\n\n```js\nconsole.log(1)\n```\n\n```bash\nls -la\n```'}
        onOpenExternal={() => undefined}
      />
    )

    expect(screen.getAllByRole('button', { name: '复制代码' })).toHaveLength(2)
  })
})
