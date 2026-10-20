import { BrowserWindow, dialog } from 'electron'
import { reviewHtml, reviewPresentation } from './greeting-review-view.mjs'

export function showGreetingReview(kind: string, target: string, openChat: () => Promise<void>): Promise<string | null> {
  const allowed = new Set<string>(reviewPresentation(kind).options.map(([action]) => String(action)))
  const window = new BrowserWindow({
    width: 700, height: 820, minWidth: 620, minHeight: 740,
    title: '牛人快跑 · 人工核对', autoHideMenuBar: true, show: false,
    backgroundColor: '#f2f8f7',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: false }
  })
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (action: string | null) => {
      if (settled) return
      settled = true
      resolve(action)
      if (!window.isDestroyed()) window.destroy()
    }
    window.on('closed', () => finish(null))
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('before-input-event', (_event, input) => {
      if (input.key === 'Escape') finish(null)
    })
    window.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      if (settled) return
      if (url === 'https://greeting-review.invalid/open') {
        void openChat().catch(() => {
          if (!window.isDestroyed()) void dialog.showMessageBox(window, {
            type: 'warning', message: '无法打开当前聊天', detail: '请在BOSS直聘浏览器中手动打开并核对，任务仍保持停止。'
          })
        })
        return
      }
      for (const action of allowed) {
        if (url === `https://greeting-review.invalid/${action}`) {
          finish(action === 'pause' ? null : action)
          return
        }
      }
    })
    window.once('ready-to-show', () => { if (!settled) window.show() })
    void window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(reviewHtml(kind, target))).catch(err => {
      if (settled) return
      settled = true
      reject(err)
      if (!window.isDestroyed()) window.destroy()
    })
  })
}
