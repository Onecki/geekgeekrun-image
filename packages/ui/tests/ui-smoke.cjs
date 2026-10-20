const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
app.commandLine.appendSwitch('disable-gpu')
app.setPath('userData', path.join(process.env.GEEKGEEKRUN_DATA_DIR, 'electron-smoke'))
const resultFile = path.resolve(process.env.GEEKGEEKRUN_DATA_DIR, '../ui-smoke-result.json')
process.on('uncaughtException', err => { fs.writeFileSync(resultFile, JSON.stringify({ passed: false, error: err.stack })); app.exit(1) })
const config = {}
for (const name of ['boss.json', 'common-job-condition-config.json', 'target-company-list.json', 'dingtalk.json', 'llm.json']) {
  config[name] = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../geek-auto-start-chat-with-boss/default-config-file', name), 'utf8'))
}
config['boss.json'].firstGreeting = { enabled: false, imagePath: '', text: '' }
const handlers = {
  'fetch-config-file-content': () => ({ config }),
  'get-task-manager-list': () => ({ workers: [] }),
  'check-update': () => null,
  'get-build-info': () => ({ version: '0.17.4-greeting.3', buildVersion: 44 }),
  'common-job-condition-config': () => config['common-job-condition-config.json'],
  'pre-enter-setting-ui': () => true,
  'get-os-platform': () => 'win32'
}
for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(name, handler)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {
    preload: process.env.GEEKGEEKRUN_PACKED_ASAR ? path.join(process.env.GEEKGEEKRUN_PACKED_ASAR, 'out/preload/index.js') : path.resolve(__dirname, '../out/preload/index.js'), sandbox: false
  } })
  const errors = []
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  await win.loadFile(process.env.GEEKGEEKRUN_PACKED_ASAR ? path.join(process.env.GEEKGEEKRUN_PACKED_ASAR, 'out/renderer/index.html') : path.resolve(__dirname, '../out/renderer/index.html'), { hash: '/main-layout/GeekAutoStartChatWithBoss' })
  await delay(1500)
  const initial = await win.webContents.executeJavaScript(`document.body.innerText`)
  assert.ok(initial.includes('首次开聊：先图片，后固定文字'), 'Greeting settings did not render')
  const off = await win.webContents.executeJavaScript(`document.querySelector('.el-switch')?.getAttribute('aria-checked') ?? document.querySelector('.el-switch input')?.checked`)
  assert.ok(off === false || off === 'false' || off === null)
  await win.webContents.executeJavaScript(`document.querySelector('.el-switch').click()`)
  await delay(300)
  const enabled = await win.webContents.executeJavaScript(`document.body.innerText`)
  assert.ok(enabled.includes('第一条：图片') && enabled.includes('第二条：固定文字'), 'Greeting inputs missing')
  assert.equal(errors.length, 0, errors.join('\n'))
  const output = path.resolve(process.env.GEEKGEEKRUN_DATA_DIR, '../greeting-settings.png')
  fs.writeFileSync(output, (await win.webContents.capturePage()).toPNG())
  fs.writeFileSync(resultFile, JSON.stringify({ passed: true, checks: ['renderer loads', 'default disabled', 'image and text settings render', 'no renderer errors'], errors }, null, 2))
  console.log('PASS: real Electron renderer loads; feature defaults off; image/text settings render; no renderer errors')
  win.destroy(); app.exit(0)
}).catch(err => { fs.writeFileSync(resultFile, JSON.stringify({ passed: false, error: err.stack }, null, 2)); app.exit(1) })
