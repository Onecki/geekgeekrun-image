import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { GREETING_PIPE_FILE } from '../src/main/features/greeting-edition.mjs'

test('installer uses a distinct package name for its default installation folder', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, 'geekgeekrun-greeting')
  assert.notEqual(pkg.name, 'geekgeekrun-ui')
  assert.match(pkg.version, /-greeting\./)
  const builder = fs.readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  assert.match(builder, /^appId: com\.geekgeekrun\.greeting\.standalone$/m)
  assert.match(builder, /^  shortcutName: GeekGeekRun Image Greeting$/m)
})

test('custom edition never reuses the official daemon pipe storage file', () => {
  assert.equal(GREETING_PIPE_FILE, 'ipc-pipe-name-greeting')
  assert.notEqual(GREETING_PIPE_FILE, 'ipc-pipe-name')
})
