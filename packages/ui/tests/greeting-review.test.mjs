import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GreetingJournal, GreetingReviewRequired, sendGreetingWithReview, sendGreetingSequence, applyGreetingReview, REVIEW_CANCELLED } from '../src/main/features/first-greeting-state.mjs'
import { reviewHtml, reviewPresentation } from '../src/main/features/greeting-review-view.mjs'

function fixture(t, kind = 'reconcile') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-review-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const imagePath = path.join(directory, 'image.png')
  fs.writeFileSync(imagePath, Buffer.from([137,80,78,71,13,10,26,10,1]))
  const journal = new GreetingJournal(path.join(directory, 'journal'))
  const config = { enabled: true, imagePath, text: '原始固定文字' }
  const calls = []
  const options = { config, journal, accountId: 'a', bossId: 'b', adapter: {
    assertIdentity: async () => {},
    hasPreviousMessage: async () => false,
    readHistory: async () => [],
    sendImage: async () => { calls.push('image'); return 'new-image' },
    sendText: async (text, beforeClick) => { await beforeClick(); calls.push(text); return 'new-text' }
  } }
  if (kind === 'reconcile') journal.write('a', 'b', 'text-pending', {
    text: config.text, imageMessageId: 'old-image', textMessageId: 'old-text', textClickAttempted: true
  })
  else {
    let attempt = 0
    options.adapter.sendImage = async () => {
      calls.push('image')
      if (++attempt === 1) throw new GreetingReviewRequired('image-confirm', 'confirmation failed')
      return 'new-image'
    }
  }
  return { options, calls, journal }
}

for (const kind of ['image-confirm', 'reconcile']) {
  for (const action of (kind === 'image-confirm' ? ['image-sent', 'retry', null] : ['complete', 'image-sent', 'retry', null])) {
    test(`${kind}: review ${action ?? 'close/pause'} sends exactly the authorized messages`, async t => {
      const f = fixture(t, kind)
      let reviews = 0
      const review = async actual => { assert.equal(actual, kind); reviews++; return action }
      if (action === null) {
        await assert.rejects(sendGreetingWithReview(f.options, review), new RegExp(REVIEW_CANCELLED))
        assert.equal(f.journal.read('a', 'b').stage, kind === 'image-confirm' ? 'image-pending' : 'text-pending')
      } else {
        await sendGreetingWithReview(f.options, review)
        assert.equal(f.journal.read('a', 'b').stage, 'complete')
        await sendGreetingWithReview(f.options, review)
      }
      const initialImage = kind === 'image-confirm' ? ['image'] : []
      const resumed = action === 'retry' ? ['image', '原始固定文字'] : action === 'image-sent' ? ['原始固定文字'] : []
      assert.deepEqual(f.calls, [...initialImage, ...resumed])
      assert.equal(reviews, 1)
    })
  }
}

test('review keeps snapshot text and clears obsolete IDs before a full retry', async t => {
  const f = fixture(t)
  f.options.config.text = '修改后的文字'
  f.options.adapter.sendImage = async () => {
    const state = f.journal.read('a', 'b')
    assert.equal(state.imageMessageId, undefined)
    assert.equal(state.textMessageId, undefined)
    assert.equal(state.textClickAttempted, false)
    return 'new-image'
  }
  await sendGreetingWithReview(f.options, async () => 'retry')
  assert.deepEqual(f.calls, ['原始固定文字'])
})

test('a second uncertain send requires another review instead of reusing the decision', async t => {
  const f = fixture(t)
  let reviews = 0
  f.options.adapter.sendText = async (_text, beforeClick) => {
    await beforeClick()
    f.calls.push('text-attempt')
    throw new GreetingReviewRequired('reconcile', 'text uncertain')
  }
  await assert.rejects(sendGreetingWithReview(f.options, async () => ++reviews === 1 ? 'image-sent' : null), new RegExp(REVIEW_CANCELLED))
  assert.equal(reviews, 2)
  assert.deepEqual(f.calls, ['text-attempt'])
  await assert.rejects(sendGreetingSequence(f.options), /未确认/)
  assert.deepEqual(f.calls, ['text-attempt'])
})

test('identity changed during review prevents all state updates and sends', async t => {
  const f = fixture(t)
  const before = fs.readFileSync(f.journal.file('a', 'b'), 'utf8')
  await assert.rejects(sendGreetingWithReview(f.options, async () => {
    f.options.adapter.assertIdentity = async () => { throw new Error('identity changed') }
    return 'retry'
  }), /identity changed/)
  assert.equal(fs.readFileSync(f.journal.file('a', 'b'), 'utf8'), before)
  assert.deepEqual(f.calls, [])
})

test('a persisted retry decision cannot silently authorize a later process', async t => {
  const f = fixture(t)
  applyGreetingReview(f.journal, 'a', 'b', 'retry', f.options.config)
  await assert.rejects(sendGreetingSequence(f.options), /未确认/)
  assert.deepEqual(f.calls, [])
})

test('image confirmation cannot be bypassed with a complete action', async t => {
  const f = fixture(t, 'image-confirm')
  await assert.rejects(sendGreetingWithReview(f.options, async () => 'complete'), /无效/)
  assert.equal(f.journal.read('a', 'b').stage, 'image-pending')
})

test('unrelated errors never present review options or change the journal', async t => {
  const f = fixture(t)
  f.options.adapter.readHistory = async () => { throw new Error('network unavailable') }
  await assert.rejects(sendGreetingWithReview(f.options, async () => { assert.fail('unexpected review') }), /network unavailable/)
})

test('view has distinct explanations and options, escapes recipient HTML', () => {
  const image = reviewPresentation('image-confirm')
  const recovery = reviewPresentation('reconcile')
  assert.notDeepEqual(image.options, recovery.options)
  assert.match(image.reason, /发图二次确认失败，请人工核对/)
  assert.match(recovery.reason, /对账不确定，请人工核对/)
  const html = reviewHtml('reconcile', '<script>bad()</script>')
  assert.ok(!html.includes('<script>'))
  assert.ok(html.includes('&lt;script&gt;'))
  assert.throws(() => reviewPresentation('bad'))
})
