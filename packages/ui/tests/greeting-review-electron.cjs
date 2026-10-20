const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { showGreetingReview } = require(process.env.GREETING_REVIEW_BUNDLE)
app.setPath('userData', process.env.GREETING_REVIEW_DATA)
app.on('window-all-closed', e => e.preventDefault())
// Test windows stay hidden; they never connect to BOSS or send real messages.
BrowserWindow.prototype.show = function () {}
const timeout = setTimeout(() => { console.error('Review UI test timed out'); app.exit(1) }, 30000)
app.whenReady().then(async () => {
  let openCount = 0
  let checks = 0
  async function windowFor(kind) {
    const result = showGreetingReview(kind, '测试招聘者（test-boss）', async () => { openCount++ })
    const window = BrowserWindow.getAllWindows()[0]
    await new Promise((resolve, reject) => {
      window.webContents.once('did-finish-load', resolve)
      window.webContents.once('did-fail-load', (_e, _code, text) => reject(new Error(text)))
    })
    assert.equal(await window.webContents.executeJavaScript('typeof require'), 'undefined')
    return { result, window }
  }
  for (const kind of ['image-confirm', 'reconcile']) {
    const expected = kind === 'image-confirm' ? ['image-sent', 'retry', 'pause'] : ['complete', 'image-sent', 'retry']
    for (const action of expected) {
      const { result, window } = await windowFor(kind)
      const text = await window.webContents.executeJavaScript('document.body.innerText')
      assert.ok(text.includes(kind === 'image-confirm' ? '发图二次确认失败，请人工核对' : '对账不确定，请人工核对'))
      assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll(".option").length'), 3)
      if (action === expected[0]) {
        fs.writeFileSync(path.join(process.env.GREETING_REVIEW_SCREENSHOTS, kind + '.png'), (await window.webContents.capturePage()).toPNG())
        await window.webContents.executeJavaScript('document.querySelector(".open").click()')
        await new Promise(resolve => setTimeout(resolve, 50))
        assert.ok(!window.isDestroyed(), 'Opening chat must keep the decision pending')
      }
      // Actual renderer navigation must be intercepted by the production handler.
      await window.webContents.executeJavaScript(`document.querySelector('a[href="https://greeting-review.invalid/${action}"]').click()`)
      assert.equal(await result, action === 'pause' ? null : action)
      checks++
    }
    const closed = await windowFor(kind)
    closed.window.close()
    assert.equal(await closed.result, null)
    checks++
  }
  assert.equal(openCount, 2)
  console.log(JSON.stringify({ passed: true, checks, openChatChecks: openCount, sandboxed: true }))
  clearTimeout(timeout)
  app.exit(0)
}).catch(err => { console.error(err); clearTimeout(timeout); app.exit(1) })
