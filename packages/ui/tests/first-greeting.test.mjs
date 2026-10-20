import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { GreetingJournal, sendGreetingSequence, validateGreeting } from '../src/main/features/first-greeting-state.mjs'

async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
  const pid = child.pid
  await new Promise(resolve => child.on('exit', resolve))
  return pid
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-greeting-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const imagePath = path.join(directory, 'image.png')
  fs.writeFileSync(imagePath, Buffer.from([137,80,78,71,13,10,26,10,1]))
  const journal = new GreetingJournal(path.join(directory, 'journal'))
  const calls = []
  const config = { enabled: true, imagePath, text: '您好，附件是我的作品介绍。' }
  const adapter = {
    assertIdentity: async () => { calls.push('identity') },
    hasPreviousMessage: async () => false,
    sendImage: async () => { calls.push('image') },
    sendText: async () => { calls.push('text') }
  }
  return { config, journal, accountId: 'account-a', bossId: 'boss-a', adapter, calls }
}

test('image acknowledgement precedes text; completion prevents duplicate sends', async t => {
  const f = fixture(t)
  await sendGreetingSequence(f)
  assert.deepEqual(f.calls, ['identity', 'image', 'identity', 'text'])
  assert.equal(f.journal.read('account-a', 'boss-a').stage, 'complete')
  await sendGreetingSequence(f)
  assert.equal(f.calls.length, 4)
})
test('disabled feature does not touch the conversation', async t => {
  const f = fixture(t); f.config = { enabled: false }
  await sendGreetingSequence(f)
  assert.deepEqual(f.calls, [])
})
test('image error prevents text and blocks blind retry after restart', async t => {
  const f = fixture(t)
  f.adapter.sendImage = async () => { throw new Error('timeout') }
  await assert.rejects(sendGreetingSequence(f), /timeout/)
  assert.equal(f.journal.read(f.accountId, f.bossId).stage, 'image-pending')
  await assert.rejects(sendGreetingSequence(f), /未确认/)
  assert.ok(!f.calls.includes('text'))
})
test('acknowledged image can continue with text alone', async t => {
  const f = fixture(t)
  f.journal.write(f.accountId, f.bossId, 'image-sent')
  await sendGreetingSequence(f)
  assert.deepEqual(f.calls, ['identity', 'identity', 'text'])
})
test('text timeout blocks duplicate text on retry', async t => {
  const f = fixture(t)
  f.adapter.sendText = async () => { throw new Error('timeout') }
  await assert.rejects(sendGreetingSequence(f), /timeout/)
  assert.equal(f.journal.read(f.accountId, f.bossId).stage, 'text-pending')
  await assert.rejects(sendGreetingSequence(f), /未确认/)
})
test('existing outgoing message aborts first-image requirement', async t => {
  const f = fixture(t)
  f.adapter.hasPreviousMessage = async () => true
  await assert.rejects(sendGreetingSequence(f), /已有主动消息/)
  assert.deepEqual(f.calls, ['identity'])
  assert.equal(f.journal.read(f.accountId, f.bossId).stage, 'skipped')
})
test('wrong recipient cannot receive an image', async t => {
  const f = fixture(t)
  f.adapter.assertIdentity = async () => { throw new Error('identity mismatch') }
  await assert.rejects(sendGreetingSequence(f), /identity mismatch/)
  assert.deepEqual(f.calls, [])
  assert.equal(f.journal.read(f.accountId, f.bossId), null)
})
test('recipient changes after image prevent text', async t => {
  const f = fixture(t); let count = 0
  f.adapter.assertIdentity = async () => { if (++count === 2) throw new Error('identity changed') }
  await assert.rejects(sendGreetingSequence(f), /identity changed/)
  assert.deepEqual(f.calls, ['image'])
  assert.equal(f.journal.read(f.accountId, f.bossId).stage, 'image-sent')
})
test('same boss under separate accounts has independent state', t => {
  const f = fixture(t)
  f.journal.write('account-a', 'boss-a', 'complete')
  assert.equal(f.journal.read('account-b', 'boss-a'), null)
})
test('corrupt state fails closed', t => {
  const f = fixture(t)
  fs.writeFileSync(f.journal.file('account-a', 'boss-a'), '{broken')
  assert.throws(() => f.journal.read('account-a', 'boss-a'))
})
test('journal lock prevents concurrent greeting workers', t => {
  const f = fixture(t)
  const lockFile = path.join(f.journal.directory, 'task.lock')
  const unlock = f.journal.lock()
  // Holder PID is this very process → alive → must refuse with a readable message.
  assert.throws(() => f.journal.lock(), /正在运行/)
  unlock()
  assert.ok(!fs.existsSync(lockFile))
  // Re-take after release works.
  f.journal.lock()()
})
test('stale lock from a dead PID is taken over automatically', async t => {
  const f = fixture(t)
  const lockFile = path.join(f.journal.directory, 'task.lock')
  const pid = await deadPid()
  fs.mkdirSync(f.journal.directory, { recursive: true })
  fs.writeFileSync(lockFile, String(pid))
  const unlock = f.journal.lock()
  assert.equal(fs.readFileSync(lockFile, 'utf8'), String(process.pid))
  unlock()
  assert.ok(!fs.existsSync(lockFile))
})
test('corrupt lock content is treated as stale and taken over', t => {
  const f = fixture(t)
  const lockFile = path.join(f.journal.directory, 'task.lock')
  fs.mkdirSync(f.journal.directory, { recursive: true })
  fs.writeFileSync(lockFile, 'not-a-pid')
  const unlock = f.journal.lock()
  assert.equal(fs.readFileSync(lockFile, 'utf8'), String(process.pid))
  unlock()
})
test('invalid images and empty text fail before sending', t => {
  const f = fixture(t)
  assert.throws(() => validateGreeting({ ...f.config, text: '   ' }), /不能为空/)
  fs.writeFileSync(f.config.imagePath, 'not an image')
  assert.throws(() => validateGreeting(f.config), /PNG/)
  assert.throws(() => validateGreeting({ ...f.config, imagePath: 'relative.png' }), /请选择/)
})

test('restart confirms an already delivered text without resending anything', async t => {
  const f = fixture(t)
  f.journal.write(f.accountId,f.bossId,'text-pending',{ text:f.config.text, imageMessageId:'img', textClickAttempted:true })
  f.adapter.readHistory = async () => [
    { id:'img',self:true,type:'image',status:1,time:Date.now()-1000 },
    { id:'txt',self:true,type:'text',text:f.config.text,status:1,time:Date.now() }
  ]
  await sendGreetingSequence(f)
  assert.ok(!f.calls.includes('image') && !f.calls.includes('text'))
  assert.equal(f.journal.read(f.accountId,f.bossId).stage,'complete')
})
test('a button failure before any click resumes text only', async t => {
  const f = fixture(t)
  f.journal.write(f.accountId,f.bossId,'text-pending',{ text:f.config.text, imageMessageId:'img', textClickAttempted:false })
  f.adapter.readHistory = async () => [{ id:'img',self:true,type:'image',status:1,time:Date.now() }]
  await sendGreetingSequence(f)
  assert.deepEqual(f.calls,['identity','identity','text'])
})
test('an uncertain previous send click cannot be retried blindly', async t => {
  const f = fixture(t)
  f.journal.write(f.accountId,f.bossId,'text-pending',{ text:f.config.text, imageMessageId:'img', textClickAttempted:true })
  f.adapter.readHistory = async () => [{ id:'img',self:true,type:'image',status:1,time:Date.now() }]
  await assert.rejects(sendGreetingSequence(f), /未确认/)
  assert.ok(!f.calls.includes('text'))
})
test('legacy .2 text-pending records are completed using existing server history', async t => {
  const f = fixture(t)
  f.journal.write(f.accountId,f.bossId,'text-pending')
  f.adapter.readHistory = async () => [
    { id:'img',self:true,type:'image',status:1,time:Date.now()-1000 },
    { id:'txt',self:true,type:'text',text:f.config.text,status:1,time:Date.now() }
  ]
  await sendGreetingSequence(f)
  assert.equal(f.journal.read(f.accountId,f.bossId).stage,'complete')
  assert.ok(!f.calls.includes('text') && !f.calls.includes('image'))
})
test('a reply after the image prevents an automatic stale greeting', async t => {
  const f = fixture(t)
  f.journal.write(f.accountId,f.bossId,'image-sent',{ text:f.config.text,imageMessageId:'img' })
  f.adapter.readHistory = async () => [
    { id:'img',self:true,type:'image',status:1,time:Date.now()-1000 },
    { id:'reply',self:false,type:'text',status:0,time:Date.now() }
  ]
  await assert.rejects(sendGreetingSequence(f), /未确认/)
  assert.ok(!f.calls.includes('text'))
})
test('a stored text snapshot survives config edits and journal transitions', async t => {
  const f = fixture(t)
  f.journal.write(f.accountId,f.bossId,'image-sent',{ text:'原先的固定文字',imageMessageId:'img' })
  f.adapter.readHistory = async () => [{ id:'img',self:true,type:'image',status:1,time:Date.now() }]
  f.adapter.sendText = async text => { assert.equal(text,'原先的固定文字') }
  await sendGreetingSequence(f)
  assert.equal(f.journal.read(f.accountId,f.bossId).imageMessageId,'img')
  assert.equal(f.journal.read(f.accountId,f.bossId).text,'原先的固定文字')
})
