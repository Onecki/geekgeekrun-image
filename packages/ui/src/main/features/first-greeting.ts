import path from 'node:path'
import type { Page, ElementHandle } from 'puppeteer'
import { ChatStartupLog } from '@geekgeekrun/sqlite-plugin/dist/entity/ChatStartupLog'
import { JobInfo } from '@geekgeekrun/sqlite-plugin/dist/entity/JobInfo'
import { readConfigFile, storageFilePath } from '@geekgeekrun/geek-auto-start-chat-with-boss/runtime-file-utils.mjs'
import { GreetingJournal, validateGreeting, sendGreetingWithReview, GreetingReviewRequired, REVIEW_CANCELLED } from './first-greeting-state.mjs'
import { fillAndSendChatText, normalizeChatText } from './boss-chat-editor.mjs'
import { showGreetingReview } from './greeting-review'

export const GREETING_ERROR = 'FIRST_GREETING_STOPPED: '

// Use the same Vue-backed DOM contract as the project's existing reminder flow.
async function identity(page: Page, accountId: string, bossId: string) {
  const matches = await page.evaluate((accountId, bossId) => {
    const user = (document.querySelector('.main-wrap') as any)?.__vue__?.$store?.state?.userInfo
    const boss = (document.querySelector('.chat-conversation .chat-record') as any)?.__vue__?.boss
    return user?.encryptUserId === accountId && boss?.encryptBossId === bossId
  }, accountId, bossId)
  if (!matches) throw new Error('当前账号或聊天对象与目标不一致，已停止发送')
}

async function messages(page: Page) {
  return page.evaluate(() => {
    const list = (document.querySelector('.message-content .chat-record') as any)?.__vue__?.list$
    if (!Array.isArray(list)) throw new Error('无法读取聊天记录，网页结构可能已变化')
    return list.map((m: any) => ({
      id: String(m.mid ?? m.messageId ?? m.id ?? ''),
      self: m.isSelf === true, type: m.messageType, status: m.status,
      templateId: m.templateId, text: m.text ?? m.body?.text ?? '', time: Number(m.time)
    }))
  })
}

async function acknowledged(page: Page, before: Awaited<ReturnType<typeof messages>>, type: string, text?: string) {
  const oldIds = new Set(before.map(m => m.id).filter(Boolean))
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const list = await messages(page)
    const match = list.find(m => m.id && !oldIds.has(m.id) && m.self && m.type === type &&
      (m.status === 1 || m.status === 2) && (text === undefined || normalizeChatText(m.text) === normalizeChatText(text)))
    if (match) return match.id
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error('未能确认消息发送成功，已停止。请检查聊天记录，勿直接重复发送')
}

async function selectConversation(page: Page, bossId: string) {
  await page.goto('https://www.zhipin.com/web/geek/chat', { waitUntil: 'networkidle2', timeout: 45000 })
  await page.waitForFunction(() => Array.isArray((document.querySelector('.main-wrap .chat-user') as any)?.__vue__?.list))
  for (let attempt = 0; attempt < 60; attempt++) {
    const index = await page.evaluate(bossId => {
      return (document.querySelector('.main-wrap .chat-user') as any).__vue__.list
        .findIndex((it: any) => it.encryptBossId === bossId)
    }, bossId)
    if (index >= 0) {
      const alreadySelected = await page.evaluate(bossId =>
        (document.querySelector('.chat-conversation .chat-record') as any)?.__vue__?.boss?.encryptBossId === bossId &&
        Array.isArray((document.querySelector('.message-content .chat-record') as any)?.__vue__?.list$), bossId)
      if (alreadySelected) return
      await page.evaluate(index => {
        (document.querySelector('.chat-content .user-list .user-list-content') as any)?.__vue__?.scrollToIndex(index)
      }, index)
      await page.waitForFunction(bossId => Array.from(document.querySelectorAll('li[role=listitem]'))
        .some((el: any) => el.__vue__?.source?.encryptBossId === bossId), {}, bossId)
      const history = page.waitForResponse(r => r.url().startsWith('https://www.zhipin.com/wapi/zpchat/geek/historyMsg'), { timeout: 30000 })
      // Attach the rejection handler before clicking; no unhandled timeout on DOM failure.
      void history.catch(() => undefined)
      const target = await page.evaluateHandle(bossId => Array.from(document.querySelectorAll('li[role=listitem]'))
        .find((el: any) => el.__vue__?.source?.encryptBossId === bossId), bossId)
      const element = target.asElement() as ElementHandle<Element> | null
      if (!element) throw new Error('无法定位目标聊天')
      await element.click()
      await history
      await page.waitForFunction(bossId =>
        (document.querySelector('.chat-conversation .chat-record') as any)?.__vue__?.boss?.encryptBossId === bossId,
      {}, bossId)
      return
    }
    const canScroll = await page.evaluate(() => {
      const view = (document.querySelector('.chat-content .user-list .user-list-content') as any)?.__vue__
      if (!view?.scrollToBottom) return false
      view.scrollToBottom()
      return true
    })
    if (!canScroll) break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('未找到目标招聘者的会话，已停止')
}

async function confirmSavedMessage(page: Page, accountId: string, bossId: string, messageId: string, type: string) {
  // A local "unread" bubble alone is not proof of delivery. Reload the chat from
  // the server and require that same message to appear in its history.
  await selectConversation(page, bossId)
  await identity(page, accountId, bossId)
  const saved = (await messages(page)).some(m => m.id === messageId && m.self && m.type === type && (m.status === 1 || m.status === 2))
  if (!saved) throw new GreetingReviewRequired(type === 'image' ? 'image-confirm' : 'reconcile', '服务器历史记录中尚未确认消息，已停止，避免重复发送')
}

export class FirstGreetingPlugin {
  constructor(private database: Promise<any>) {}
  apply(hooks: any) {
    const config = readConfigFile('boss.json').firstGreeting
    if (!config?.enabled) return
    let accountId = ''
    let sourcePage: Page
    let historicalBosses = new Set<string>()
    let historicalJobs = new Set<string>()
    let blockedBosses: Set<string> = new Set()
    const journal = new GreetingJournal(path.join(storageFilePath, 'first-greeting'))
    const stop = (err: any): never => {
      if (err?.message === REVIEW_CANCELLED) throw err
      throw new Error(GREETING_ERROR + (err?.message ?? String(err)))
    }
    hooks.pageGotten.tap('FirstGreetingPlugin', (page: Page) => { sourcePage = page })
    hooks.userInfoResponse.tapPromise('FirstGreetingPlugin', async ({ userInfoResponse }: any) => {
      accountId = userInfoResponse?.zpData?.encryptUserId ?? ''
      try {
        // This hook runs after mainFlowWillLaunch: identity is available only now.
        if (userInfoResponse?.code !== 0) return
        if (!accountId) throw new Error('无法确认当前账号')
        const ds = await this.database
        const rows = await ds.getRepository(ChatStartupLog).createQueryBuilder('log')
          .leftJoin(JobInfo, 'job', 'job.encryptJobId = log.encryptJobId')
          .select('log.encryptJobId', 'jobId').addSelect('job.encryptBossId', 'bossId')
          .where('log.encryptCurrentUserId = :accountId', { accountId }).getRawMany()
        historicalBosses = new Set(rows.map((r: any) => r.bossId).filter(Boolean))
        historicalJobs = new Set(rows.map((r: any) => r.jobId).filter(Boolean))
        for (const id of historicalBosses) blockedBosses.add(id)
        // Finish/reconcile the journal before considering any new recipients.
        for (const pending of journal.list(accountId).filter(s => !['complete', 'skipped'].includes(s.stage))) {
          await deliver(pending.bossId)
        }
      } catch (err) { stop(err) }
    })
    hooks.mainFlowWillLaunch.tapPromise('FirstGreetingPlugin', async ({ blockBossNotNewChat }: any) => {
      try {
        validateGreeting(config)
        blockedBosses = blockBossNotNewChat
      } catch (err) { stop(err) }
    })
    hooks.newChatWillStartup.tapPromise('FirstGreetingPlugin', async (job: any) => {
      try {
        if (historicalBosses.has(job.jobInfo.encryptUserId) || historicalJobs.has(job.jobInfo.encryptId)) {
          throw new Error('检测到历史开聊记录，已阻止重复开聊')
        }
        const previous = journal.read(accountId, job.jobInfo.encryptUserId)
        if (previous) throw new Error('该招聘者已有发送记录，已阻止重复开聊')
        validateGreeting(config)
      } catch (err) { stop(err) }
    })
    const deliver = async (bossId: string) => {
      let page: Page | undefined
      let unlock: (() => void) | undefined
      try {
        unlock = journal.lock()
        if (!bossId || !accountId) throw new Error('账号或招聘者身份缺失')
        page = await sourcePage.browser().newPage()
        await selectConversation(page, bossId)
        const chat = page
        await sendGreetingWithReview({ config, journal, accountId, bossId, adapter: {
          assertIdentity: () => identity(chat, accountId, bossId),
          readHistory: () => messages(chat),
          hasPreviousMessage: async () => (await messages(chat)).some(m => m.self),
          sendImage: async (imagePath: string) => {
            await identity(chat, accountId, bossId)
            const before = await messages(chat)
            const input = await chat.$('.chat-conversation input[type=file][accept*="image"], .chat-conversation input[type=file][accept*=".png"], .chat-conversation input[type=file][accept*=".jpg"]')
            if (!input) throw new Error('未找到图片上传控件，网页可能已改版')
            await input.uploadFile(imagePath)
            // Only accept an acknowledged image message; an upload preview alone is insufficient.
            const messageId = await acknowledged(chat, before, 'image')
            journal.write(accountId, bossId, 'image-pending', { imageMessageId: messageId })
            await confirmSavedMessage(chat, accountId, bossId, messageId, 'image')
            await identity(chat, accountId, bossId)
            return messageId
          },
          sendText: async (text: string, beforeClick: () => Promise<void>) => {
            await identity(chat, accountId, bossId)
            const before = await messages(chat)
            await fillAndSendChatText(chat, text, () => identity(chat, accountId, bossId), { beforeClick })
            const messageId = await acknowledged(chat, before, 'text', text)
            await confirmSavedMessage(chat, accountId, bossId, messageId, 'text')
            await identity(chat, accountId, bossId)
            return messageId
          }
        } }, async kind => {
          // Keep the task lock and the target chat open while awaiting a decision.
          const label = await chat.evaluate(() => {
            const boss = (document.querySelector('.chat-conversation .chat-record') as any)?.__vue__?.boss
            return String(boss?.name ?? boss?.bossName ?? '')
          })
          return showGreetingReview(kind, label ? `${label}（${bossId}）` : bossId, async () => {
            await identity(chat, accountId, bossId)
            await chat.bringToFront()
          })
        })
        console.log('[先图后文] 已确认图片及固定文字发送成功')
      } catch (err) { stop(err) }
      finally {
        if (page) await page.close().catch(() => undefined)
        unlock?.()
      }
    }
    hooks.newChatStartup.tapPromise('FirstGreetingPlugin', (job: any) => deliver(job.jobInfo.encryptUserId))
  }
}
