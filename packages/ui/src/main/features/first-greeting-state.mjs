import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { normalizeChatText } from './boss-chat-editor.mjs'

export class GreetingReviewRequired extends Error {
  constructor(kind, message) {
    super(message)
    this.name = 'GreetingReviewRequired'
    this.kind = kind
  }
}

export const REVIEW_CANCELLED = 'FIRST_GREETING_REVIEW_CANCELLED'

export async function sendGreetingWithReview(options, review) {
  let manualAction
  while (true) {
    try {
      await sendGreetingSequence({ ...options, manualAction })
      return
    } catch (err) {
      manualAction = undefined
      if (!(err instanceof GreetingReviewRequired)) throw err
      await options.adapter.assertIdentity()
      const action = await review(err.kind)
      if (action === null) throw new Error(REVIEW_CANCELLED)
      if (!(err.kind === 'image-confirm' ? ['image-sent', 'retry'] : ['complete', 'image-sent', 'retry']).includes(action)) {
        throw new Error('无效的人工核对选项')
      }
      await options.adapter.assertIdentity()
      applyGreetingReview(options.journal, options.accountId, options.bossId, action, options.config)
      if (action === 'complete') return
      manualAction = action
    }
  }
}

// A decision authorizes only the immediate retry, never an unattended restart.
export function applyGreetingReview(journal, accountId, bossId, action, config) {
  const previous = journal.read(accountId, bossId)
  if (!previous || ['complete', 'skipped'].includes(previous.stage)) throw new Error('发送状态已变化，请重新核对')
  if (!['complete', 'image-sent', 'retry'].includes(action)) throw new Error('无效的人工核对选项')
  const extra = { text: previous.text ?? normalizeChatText(config.text), manualReviewedAt: new Date().toISOString(), manualDecision: action }
  if (action !== 'complete') Object.assign(extra, { textMessageId: undefined, textClickAttempted: false })
  if (action === 'retry') Object.assign(extra, { imageMessageId: undefined, startedAt: new Date().toISOString() })
  journal.write(accountId, bossId, action === 'retry' ? 'prepared' : action, extra)
}

// Check whether a PID is still alive. `kill(pid, 0)` sends no signal on
// POSIX; on Windows it merely tests existence. ESRCH = no such process,
// EPERM = exists but inaccessible (treat as alive to be safe).
function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

export function reconcileGreeting(previous, messages, text) {
  const outgoing = messages.filter(m => m.self && (m.status === 1 || m.status === 2))
  let images
  if (previous.imageMessageId) {
    images = outgoing.filter(m => m.type === 'image' && m.id === previous.imageMessageId)
  } else {
    const time = Date.parse(previous.startedAt ?? previous.updatedAt)
    if (!Number.isFinite(time)) return { kind: 'uncertain' }
    // Compatibility with .1/.2 records, which did not store message IDs.
    images = outgoing.filter(m => m.type === 'image' && Number(m.time) >= time - 5 * 60000 && Number(m.time) <= time + 60000)
  }
  if (images.length !== 1) return { kind: 'uncertain' }
  const image = images[0]
  const index = messages.findIndex(m => m.id === image.id)
  const after = messages.slice(index + 1)
  const matched = after.find(m => m.self && m.type === 'text' && (m.status === 1 || m.status === 2) && normalizeChatText(m.text) === normalizeChatText(text))
  if (matched) return { kind: 'complete', imageMessageId: image.id, textMessageId: matched.id }
  if (after.some(m => m.self || (!m.self && ['text', 'image', 'sound', 'video'].includes(m.type)))) return { kind: 'uncertain' }
  if (previous.text !== undefined && (previous.stage === 'image-sent' || (previous.stage === 'text-pending' && previous.textClickAttempted === false))) {
    return { kind: 'image-sent', imageMessageId: image.id }
  }
  return { kind: 'uncertain' }
}

export function validateGreeting(config) {
  if (!config?.enabled) return
  if (typeof config.text !== 'string' || !config.text.trim() || config.text.length > 1000) {
    throw new Error('固定文字不能为空，且不能超过1000字')
  }
  if (typeof config.imagePath !== 'string' || !path.isAbsolute(config.imagePath)) {
    throw new Error('请选择本地 PNG 或 JPG 图片')
  }
  const data = fs.readFileSync(config.imagePath)
  if (data.length === 0 || data.length > 10 * 1024 * 1024) throw new Error('图片应小于等于10MB且不能为空')
  const png = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const jpg = data[0] === 255 && data[1] === 216 && data[2] === 255
  if (!png && !jpg) throw new Error('图片内容必须是 PNG 或 JPG 格式')
}

// Files are separate from public.db: no changes to existing tables or migrations.
export class GreetingJournal {
  constructor(directory) {
    this.directory = directory
    fs.mkdirSync(directory, { recursive: true })
  }
  file(accountId, bossId) {
    if (!accountId || !bossId) throw new Error('无法确认账号或招聘者身份')
    return path.join(this.directory, createHash('sha256').update(JSON.stringify([accountId, bossId])).digest('hex') + '.json')
  }
  read(accountId, bossId) {
    const file = this.file(accountId, bossId)
    if (!fs.existsSync(file)) return null
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (data.accountId !== accountId || data.bossId !== bossId ||
        !['prepared', 'image-pending', 'image-sent', 'text-pending', 'complete', 'skipped'].includes(data.stage)) {
      throw new Error('发送状态记录损坏，请停止任务并检查备份')
    }
    return data
  }
  write(accountId, bossId, stage, extra = {}) {
    const file = this.file(accountId, bossId)
    const temporary = file + '.tmp'
    const data = { ...this.read(accountId, bossId), ...extra, accountId, bossId, stage, updatedAt: new Date().toISOString() }
    const fd = fs.openSync(temporary, 'w')
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2))
      fs.fsyncSync(fd)
    } finally { fs.closeSync(fd) }
    fs.renameSync(temporary, file)
  }
  list(accountId) {
    return fs.readdirSync(this.directory).filter(n => n.endsWith('.json')).map(name => {
      const data = JSON.parse(fs.readFileSync(path.join(this.directory, name), 'utf8'))
      return data.accountId === accountId ? this.read(accountId, data.bossId) : null
    }).filter(Boolean)
  }
  lock() {
    const file = path.join(this.directory, 'task.lock')
    const take = () => {
      const fd = fs.openSync(file, 'wx')
      fs.writeFileSync(fd, String(process.pid))
      return fd
    }
    let fd
    try {
      fd = take()
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      // Lock file already exists. Read the PID it holds and decide whether
      // this is a real concurrent worker or a stale lock left behind by a
      // crashed / force-killed previous run.
      let holderPid = NaN
      try {
        holderPid = parseInt(fs.readFileSync(file, 'utf8').trim(), 10)
      } catch { /* unreadable / corrupt → treat as stale */ }
      if (Number.isFinite(holderPid) && pidAlive(holderPid)) {
        throw new Error(`检测到另一个先图后文任务正在运行（PID=${holderPid}），请先在原窗口停止任务后再启动`)
      }
      // Stale lock: previous process died without cleaning up. Take over.
      try { fs.unlinkSync(file) } catch { /* already gone */ }
      console.warn(`[先图后文] 检测到上次任务残留的锁文件（PID=${holderPid || '未知'}），进程已退出，自动接管`)
      fd = take()
    }
    return () => {
      try { fs.closeSync(fd) } catch { /* fd already closed */ }
      try { fs.unlinkSync(file) } catch { /* already removed */ }
    }
  }
}

export async function sendGreetingSequence({ config, journal, accountId, bossId, adapter, manualAction }) {
  validateGreeting(config)
  if (!config?.enabled) return
  const previous = journal.read(accountId, bossId)
  if (previous?.stage === 'complete' || previous?.stage === 'skipped') return
  await adapter.assertIdentity()
  const text = previous?.text ?? normalizeChatText(config.text)
  if (manualAction && !['image-sent', 'retry'].includes(manualAction)) throw new Error('无效的人工核对选项')
  if (manualAction && previous?.stage !== (manualAction === 'retry' ? 'prepared' : 'image-sent')) throw new Error('发送状态已变化，请重新核对')
  if (previous && adapter.readHistory && !manualAction) {
    const result = reconcileGreeting(previous, await adapter.readHistory(), text)
    if (result.kind === 'complete') {
      journal.write(accountId, bossId, 'complete', result)
      return
    }
    if (result.kind !== 'image-sent') throw new GreetingReviewRequired('reconcile', '上次发送结果未确认，已停止以避免重复发送。请核对聊天记录和发送状态')
    journal.write(accountId, bossId, 'image-sent', result)
  } else if (previous && previous.stage !== 'image-sent' && !manualAction) {
    throw new GreetingReviewRequired('reconcile', '上次发送结果未确认，已停止以避免重复发送。请核对聊天记录和发送状态')
  }
  if (!previous || manualAction === 'retry') {
    if (!manualAction && await adapter.hasPreviousMessage()) {
      journal.write(accountId, bossId, 'skipped', { reason: 'existing-message' })
      throw new Error('检测到已有主动消息，无法保证图片为第一条。请检查BOSS自动招呼设置')
    }
    journal.write(accountId, bossId, 'image-pending', { text, startedAt: new Date().toISOString() })
    const imageMessageId = await adapter.sendImage(config.imagePath)
    journal.write(accountId, bossId, 'image-sent', { imageMessageId })
  }
  await adapter.assertIdentity()
  journal.write(accountId, bossId, 'text-pending', { textClickAttempted: false })
  const textMessageId = await adapter.sendText(text, async () => {
    journal.write(accountId, bossId, 'text-pending', { textClickAttempted: true })
  })
  journal.write(accountId, bossId, 'complete', { textMessageId })
}
