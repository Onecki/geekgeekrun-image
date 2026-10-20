const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { initDb } = require('../../sqlite-plugin/dist/index.js')
;(async () => {
  const directory = process.env.GEEKGEEKRUN_DATA_DIR
  assert.ok(directory, 'An isolated data directory is required')
  const ds = await initDb(path.join(directory, 'storage/public.db'))
  const before = JSON.parse(fs.readFileSync(path.join(directory, '../database-before.json'), 'utf8'))
  const counts = {}
  for (const table of Object.keys(before.counts)) {
    const result = await ds.query(`SELECT count(*) AS count FROM "${table.replaceAll('"', '""')}"`)
    counts[table] = result[0].count
    if (table !== 'migrations') assert.equal(counts[table], before.counts[table], `Changed records: ${table}`)
  }
  const check = await ds.query('PRAGMA quick_check')
  assert.equal(check[0].quick_check, 'ok')
  const result = { quickCheck: 'ok', counts, allExistingTablesPreserved: true }
  fs.writeFileSync(path.join(directory, '../database-after.json'), JSON.stringify(result, null, 2))
  await ds.destroy()
  console.log('PASS: copied database opens; all existing row counts preserved; chat records=' + counts.chat_startup_log)
})().catch(err => { console.error(err); process.exit(1) })
