import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import puppeteer from 'puppeteer'
import { fillAndSendChatText } from '../src/main/features/boss-chat-editor.mjs'
import { GreetingJournal, sendGreetingSequence } from '../src/main/features/first-greeting-state.mjs'

let browser
before(async () => {
  const executablePath = process.env.GEEKGEEKRUN_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  browser = await puppeteer.launch({ executablePath, headless: true })
})
after(async () => { await browser?.close() })

async function fixture(t, { oldLayout = false, neverEnable = false, enableDelay = 100 } = {}) {
  const page = await browser.newPage()
  t.after(() => page.close())
  // Structure captured from the user's current BOSS page on 2026-10-20.
  // Its send control is disabled via a CSS class, and Unicode insertText alone
  // can leave editor state unsynchronised until a keyboard event occurs.
  await page.setContent(`<style>.chat-input { min-height:80px;width:500px;border:1px solid #aaa } button { width:80px;height:30px }</style>
    <button class="btn-send" id="unrelated">发送</button>
    <div class="chat-conversation"><div class="message-controls"><div class="chat-im chat-editor">
    <div class="chat-controls"><div class="toolbar-btn-content icon btn-sendimg"><input type="file" accept="image/png,image/jpeg"></div></div>
    <div class="${oldLayout ? 'legacy-container' : 'editor-container'}"><div contenteditable="true" id="chat-input" class="chat-input"></div>
    <div class="chat-op"><span class="tip">按Enter键发送，按Ctrl+Enter键换行</span><button type="send" class="btn-v2 btn-sure-v2 btn-send disabled">发送</button></div></div></div></div></div>`)
  await page.evaluate(({ neverEnable, enableDelay }) => {
    window.sent = []; window.enterEvents = 0; window.historyMessages = []; window.unrelatedClicks = 0
    const input = document.querySelector('.chat-input')
    const button = document.querySelector('.chat-conversation .btn-send')
    input.addEventListener('keydown', e => { if (e.key === 'Enter') window.enterEvents++ })
    input.addEventListener('keyup', () => {
      if (!neverEnable) setTimeout(() => button.classList.toggle('disabled', !input.innerText.trim()), enableDelay)
    })
    button.addEventListener('click', () => {
      if (button.classList.contains('disabled')) return
      const text = input.innerText.trim()
      window.sent.push(text)
      window.historyMessages.push({ id: 'text-' + Date.now(), type: 'text', text, self: true, status: 1, time: Date.now() })
      input.innerText = ''; button.classList.add('disabled')
    })
    document.querySelector('input[type=file]').addEventListener('change', () => {
      window.historyMessages.push({ id: 'image-1', type: 'image', self: true, status: 1, time: Date.now() })
    })
    document.querySelector('#unrelated').addEventListener('click', () => window.unrelatedClicks++)
  }, { neverEnable, enableDelay })
  return page
}

test('reproduces old Chinese typing failure and sends only once after editor synchronisation', async t => {
  const page = await fixture(t)
  const input = await page.$('.chat-input')
  await input.type('您好，这是我的作品介绍')
  assert.equal(await page.$('.chat-conversation .btn-send:not(.disabled)'), null)
  await fillAndSendChatText(page, '您好，这是我的作品介绍', async () => {})
  assert.deepEqual(await page.evaluate(() => window.sent), ['您好，这是我的作品介绍'])
})
test('multiline Chinese and emoji remain one message without pressing Enter', async t => {
  const page = await fixture(t)
  const text = '您好 👋\n这是我的作品介绍\n期待进一步沟通'
  await fillAndSendChatText(page, text, async () => {})
  assert.deepEqual(await page.evaluate(() => window.sent), [text])
  assert.equal(await page.evaluate(() => window.enterEvents), 0)
  assert.equal(await page.evaluate(() => window.unrelatedClicks), 0)
})
test('supports the older editor structure', async t => {
  const page = await fixture(t, { oldLayout: true })
  await fillAndSendChatText(page, '您好', async () => {})
  assert.deepEqual(await page.evaluate(() => window.sent), ['您好'])
})
test('waits for a delayed enabled state instead of failing immediately', async t => {
  const page = await fixture(t, { enableDelay: 700 })
  await fillAndSendChatText(page, '您好', async () => {}, { timeout: 2000 })
  assert.deepEqual(await page.evaluate(() => window.sent), ['您好'])
})
test('never clicks a permanently disabled button', async t => {
  const page = await fixture(t, { neverEnable: true })
  await assert.rejects(fillAndSendChatText(page, '您好', async () => {}, { timeout: 350 }), /未能启用/)
  assert.deepEqual(await page.evaluate(() => window.sent), [])
})
test('a different draft is preserved and not sent', async t => {
  const page = await fixture(t)
  await page.$eval('.chat-input', el => { el.innerText = '另一条未发送草稿' })
  await assert.rejects(fillAndSendChatText(page, '您好', async () => {}), /不同草稿/)
  assert.deepEqual(await page.evaluate(() => window.sent), [])
  assert.equal(await page.$eval('.chat-input', el => el.innerText), '另一条未发送草稿')
})
test('an identity change immediately before clicking prevents sending', async t => {
  const page = await fixture(t); let calls = 0
  await assert.rejects(fillAndSendChatText(page, '您好', async () => { if (++calls === 3) throw new Error('identity changed') }), /identity changed/)
  assert.deepEqual(await page.evaluate(() => window.sent), [])
})
test('image upload, text send and restart recovery work as one browser flow', async t => {
  const page = await fixture(t)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-browser-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const imagePath = path.join(directory, 'image.png')
  fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=', 'base64'))
  const journal = new GreetingJournal(path.join(directory, 'journal'))
  const options = { config: { enabled: true, imagePath, text: '您好\n这是固定文字' }, journal, accountId:'account', bossId:'boss', adapter: {
    assertIdentity: async () => {},
    hasPreviousMessage: async () => false,
    readHistory: () => page.evaluate(() => window.historyMessages),
    sendImage: async file => { await (await page.$('input[type=file]')).uploadFile(file); return 'image-1' },
    sendText: async text => { await fillAndSendChatText(page, text, async () => {}); return await page.evaluate(() => window.historyMessages.at(-1).id) }
  } }
  await sendGreetingSequence(options)
  assert.deepEqual(await page.evaluate(() => window.historyMessages.map(m => m.type)), ['image','text'])
  const completed = journal.read('account','boss')
  assert.equal(completed.imageMessageId, 'image-1')
  // Simulate losing the local final acknowledgement after the server saved text.
  journal.write('account','boss','text-pending')
  await sendGreetingSequence(options)
  assert.deepEqual(await page.evaluate(() => window.historyMessages.map(m => m.type)), ['image','text'])
  assert.equal(journal.read('account','boss').stage, 'complete')
})
