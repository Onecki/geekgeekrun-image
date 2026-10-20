import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import buildSqlitePlugin from './steps/build-sqlite-plugin.mjs'
buildSqlitePlugin()
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../test-data')
const result = spawnSync('pnpm exec electron-vite dev', {
  shell: true, stdio: 'inherit',
  env: { ...process.env, GEEKGEEKRUN_DATA_DIR: process.env.GEEKGEEKRUN_DATA_DIR || directory }
})
process.exit(result.status ?? 1)
