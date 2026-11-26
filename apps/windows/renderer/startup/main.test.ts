/// <reference types="node" />

import { readFileSync } from 'node:fs'

import { startupNoticeText } from './main'

const startupCss = readFileSync('apps/windows/renderer/startup/startup.css', 'utf8')

describe('startupNoticeText', () => {
  it('uses a distinct message for ordinary and repeated launches', () => {
    expect(startupNoticeText('?kind=started')).toBe('TextLens 已启动')
    expect(startupNoticeText('?kind=running')).toBe('TextLens 已在运行')
    expect(startupNoticeText('')).toBe('TextLens 已启动')
  })

  // Unknown kinds must keep the old "started" text: a stale renderer build may
  // not know a kind the backend just started sending.
  it('explains why a capture produced nothing, and falls back safely', () => {
    expect(startupNoticeText('?kind=captureBlockedElevated')).toContain('管理员')
    expect(startupNoticeText('?kind=captureBlockedRemote')).toContain('远程桌面')
    expect(startupNoticeText('?kind=settingsUnsaved')).toContain('未保存')
    expect(startupNoticeText('?kind=somethingNew')).toBe('TextLens 已启动')
  })

  it('holds for one second and fades during the final half second', () => {
    expect(startupCss).toMatch(/animation:\s*startup-notice-lifetime\s+1\.5s/)
    expect(startupCss).toContain('66.6667%')
    expect(startupCss).toMatch(/100%\s*\{\s*opacity:\s*0/s)
  })
})
