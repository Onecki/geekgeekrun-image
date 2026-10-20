import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import electron from 'electron'

test('real Electron review windows dispatch all choices, open chat and close safely', { timeout: 45000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-review-ui-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const bundle = path.join(directory, 'review.cjs')
  await build({ entryPoints: [fileURLToPath(new URL('../src/main/features/greeting-review.ts', import.meta.url))], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  const screenshots = process.env.GREETING_REVIEW_SCREENSHOTS || directory
  fs.mkdirSync(screenshots, { recursive: true })
  const env = { ...process.env, GREETING_REVIEW_BUNDLE: bundle, GREETING_REVIEW_DATA: path.join(directory, 'profile'), GREETING_REVIEW_SCREENSHOTS: screenshots }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [fileURLToPath(new URL('./greeting-review-electron.cjs', import.meta.url))], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null) child.kill() })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  assert.equal(code, 0, output)
  assert.ok(output.includes('"passed":true'), output)
})
