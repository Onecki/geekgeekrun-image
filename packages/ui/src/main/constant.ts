import path from 'node:path'
import os from 'node:os'

export const cacheDir = path.join(process.env.GEEKGEEKRUN_DATA_DIR || path.join(os.homedir(), '.geekgeekrun'), 'cache')
