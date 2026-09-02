import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const releaseDir = path.resolve(__dirname, '../release')

const RETRIES = 5
const RETRY_DELAY_MS = 1000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Removes the previous release output before packaging.
 *
 * On Windows the packaged files are regularly held by something else — the app
 * still running, a file sync on Desktop or OneDrive, or an antivirus scanning
 * the freshly written uninstaller — and electron-builder then fails half way
 * through with EPERM. Retrying here turns that into either a clean build or a
 * message that names the cause.
 */
async function clean() {
  if (!fs.existsSync(releaseDir)) return

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      fs.rmSync(releaseDir, { recursive: true, force: true })
      return
    } catch (err) {
      const locked = err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES'
      if (!locked || attempt === RETRIES) {
        console.error(`\nCannot clean ${releaseDir}`)
        console.error(`  ${err.code}: ${err.message}\n`)
        console.error('Something is holding those files. The usual suspects:')
        console.error('  - DofEmu is still running (close it, check the task manager)')
        console.error('  - the folder is synced by OneDrive (pause it, or move the project')
        console.error('    out of Desktop/Documents to somewhere like C:\\dev\\DofuEmu)')
        console.error('  - an antivirus is scanning the generated uninstaller: add an')
        console.error('    exclusion for the project folder')
        process.exit(1)
      }
      console.log(`release/ is locked (${err.code}), retrying in ${RETRY_DELAY_MS}ms...`)
      await sleep(RETRY_DELAY_MS)
    }
  }
}

clean()
