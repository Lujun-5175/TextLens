import '../../../../src/renderer/styles.css'
import './startup.css'

export function startupNoticeText(search: string): string {
  switch (new URLSearchParams(search).get('kind')) {
    case 'running':
      return 'TextLens 已在运行'
    case 'captureBlockedElevated':
      return '该应用以管理员权限运行，需要以管理员身份启动 TextLens 才能划词'
    case 'captureBlockedRemote':
      return '远程桌面画面无法读取文字，请在本机应用里划词'
    case 'settingsUnsaved':
      return '有未保存的设置，请先在设置窗口保存或放弃'
    default:
      return 'TextLens 已启动'
  }
}

const root = document.querySelector<HTMLElement>('#root')
if (root) {
  root.innerHTML = `
    <div class="startup-notice" role="status" aria-live="polite">
      <span class="startup-notice__mark" aria-hidden="true">✓</span>
      <span>${startupNoticeText(window.location.search)}</span>
    </div>
  `
  root.classList.add('startup-notice-root--ready')
}
