import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * A declaration missing its semicolon does not fail the build: the parser folds
 * it into the next declaration and drops both. That is how `z-index: var(--x)`
 * followed by `right: 0` silently removed a result window's right anchor and
 * shrank the footer to its content — invisible to every DOM test.
 *
 * This walks the stylesheets and reports a property line that is immediately
 * followed by another property line, which is never valid CSS.
 */
const STYLESHEETS = [
  'src/renderer/styles.css',
  'src/renderer/themes.css',
  'src/renderer/settings/settings.css',
  'src/renderer/result/result.css',
  'src/renderer/toolbar/toolbar.css',
  'src/renderer/ball/ball.css'
]

const declaration = /^(--)?[a-zA-Z-]+\s*:/u

function suspectLines(css: string): string[] {
  const lines = css.split('\n')
  const suspects: string[] = []
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index]!.trim()
    const next = lines[index + 1]!.trim()
    if (!line || line.startsWith('/*') || line.startsWith('*') || line.startsWith('@')) continue
    if (!declaration.test(line)) continue
    if (line.endsWith(';') || line.endsWith('{') || line.endsWith('}') || line.endsWith(',')) continue
    // A multi-line value continues into a line that is not itself a property.
    if (!declaration.test(next) || next.startsWith('/*')) continue
    suspects.push(`line ${index + 1}: ${line}`)
  }
  return suspects
}

describe('stylesheets', () => {
  it.each(STYLESHEETS)('%s has no declaration without a semicolon', (relativePath) => {
    const css = readFileSync(join(process.cwd(), relativePath), 'utf8')
    expect(suspectLines(css)).toEqual([])
  })
})
