export const normalizeChatText = text => String(text ?? '').replace(/\r\n?/g, '\n').trim()

export async function prepareChatText(page, text, assertIdentity, { timeout = 12000 } = {}) {
  const expected = normalizeChatText(text)
  if (!expected) throw new Error('固定文字不能为空')
  await assertIdentity()
  const selector = '.chat-conversation .chat-input'
  const input = await page.waitForSelector(selector, { visible: true, timeout })
  if (!input) throw new Error('未找到聊天输入框')
  const draft = normalizeChatText(await input.evaluate(el => 'value' in el ? el.value : el.innerText))
  if (draft && draft !== expected) throw new Error('输入框已有不同草稿，已停止以避免覆盖或误发')
  await input.focus()
  if (!draft) {
    // insertText preserves Unicode and newlines without pressing Enter (which
    // BOSS uses for sending). Chinese typing alone may emit no keyboard keyup.
    await page.keyboard.sendCharacter(expected)
  }
  await page.keyboard.press('ArrowRight')
  await input.evaluate(el => {
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const actual = normalizeChatText(await input.evaluate(el => 'value' in el ? el.value : el.innerText))
  if (actual !== expected) throw new Error('输入框内容与固定文字不一致，已停止')
  await assertIdentity()
  // Support both the current editor-container and the previous DOM layout.
  // Waiting is essential: .disabled is a CSS class, not a disabled attribute.
  const findButton = () => {
    const input = document.querySelector('.chat-conversation .chat-input')
    if (!input) return null
    const scope = input.closest('.editor-container') ?? input.closest('.message-controls') ?? input.closest('.chat-conversation')
    if (!scope) return null
    const candidates = [...scope.querySelectorAll('.btn-send,button,[role="button"],input[type="submit"]')].filter(el => {
      const text = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('value') || '').trim()
      if (!el.classList.contains('btn-send') && text !== '发送') return false
      const style = getComputedStyle(el)
      return el.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden' &&
        !el.disabled && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true' &&
        !['disabled', 'is-disabled', 'unable', 'is-loading'].some(c => el.classList.contains(c))
    })
    return candidates.length === 1 ? candidates[0] : null
  }
  let button
  try {
    const handle = await page.waitForFunction(findButton, { timeout, polling: 100 })
    button = handle.asElement()
    if (!button) throw new Error('发送按钮不存在')
  } catch {
    throw new Error('固定文字已填入，但发送按钮未能启用或无法唯一定位；没有点击发送，请检查网页状态')
  }
  await assertIdentity()
  const stillCorrect = await input.evaluate((el, expected) => {
    const content = 'value' in el ? el.value : el.innerText
    return String(content ?? '').replace(/\r\n?/g, '\n').trim() === expected
  }, expected)
  if (!stillCorrect) throw new Error('发送前输入内容发生变化，已停止')
  return button
}

export async function fillAndSendChatText(page, text, assertIdentity, options) {
  const button = await prepareChatText(page, text, assertIdentity, options)
  await options?.beforeClick?.()
  await assertIdentity()
  // Never retry this click automatically: a timeout could mean it was delivered.
  await button.click()
}
