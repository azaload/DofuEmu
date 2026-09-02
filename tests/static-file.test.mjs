import assert from 'assert'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { build } from 'vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const tmpDir = path.join(root, 'tests/.tmp')
const bundlePath = path.join(tmpDir, 'static-file.js')

async function bundle() {
  await build({
    configFile: false,
    logLevel: 'error',
    build: {
      ssr: true,
      target: 'node18',
      minify: false,
      emptyOutDir: false,
      outDir: tmpDir,
      lib: { entry: path.join(root, 'packages/main/static-file.ts'), formats: ['es'] }
    }
  })
  return import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`)
}

function testWindows(resolveStaticPath) {
  // How the app builds it: path.join(userData, 'game') + '/'
  const base = `${path.win32.join('C:\\Users\\me\\AppData\\Roaming\\DofEmu', 'game')}/`

  assert.strictEqual(
    resolveStaticPath(base, 'index.html', path.win32),
    'C:\\Users\\me\\AppData\\Roaming\\DofEmu\\game\\index.html',
    'the game shell is served on Windows'
  )
  assert.strictEqual(
    resolveStaticPath(base, 'build/script.js', path.win32),
    'C:\\Users\\me\\AppData\\Roaming\\DofEmu\\game\\build\\script.js',
    'nested game files are served on Windows'
  )
  assert.strictEqual(
    resolveStaticPath(base, '../../secret.txt', path.win32),
    null,
    'traversal stays blocked on Windows'
  )
  assert.strictEqual(
    resolveStaticPath(base, '..\\game-old\\script.js', path.win32),
    null,
    'a sibling directory sharing the prefix is blocked'
  )
  console.log('ok - windows paths')
}

function testPosix(resolveStaticPath) {
  const base = '/home/me/.config/DofEmu/game/'

  assert.strictEqual(
    resolveStaticPath(base, 'index.html', path.posix),
    '/home/me/.config/DofEmu/game/index.html'
  )
  assert.strictEqual(
    resolveStaticPath(base, 'build/script.js', path.posix),
    '/home/me/.config/DofEmu/game/build/script.js'
  )
  assert.strictEqual(resolveStaticPath(base, '../../../etc/passwd', path.posix), null)
  assert.strictEqual(
    resolveStaticPath(base, '/etc/passwd', path.posix),
    '/home/me/.config/DofEmu/game/etc/passwd',
    'an absolute-looking request stays inside the served root'
  )
  console.log('ok - posix paths')
}

function testEncoding(resolveStaticPath) {
  const base = '/srv/game/'

  assert.strictEqual(
    resolveStaticPath(base, 'assets/my%20file.png', path.posix),
    '/srv/game/assets/my file.png',
    'percent-encoded names are decoded'
  )
  assert.strictEqual(resolveStaticPath(base, '%E0%A4%A', path.posix), null, 'bad encoding is rejected')
  assert.strictEqual(
    resolveStaticPath(base, '..%2f..%2fetc/passwd', path.posix),
    null,
    'encoded traversal is rejected'
  )
  console.log('ok - encoded paths')
}

async function main() {
  const { resolveStaticPath } = await bundle()

  testWindows(resolveStaticPath)
  testPosix(resolveStaticPath)
  testEncoding(resolveStaticPath)

  console.log('\nAll static file tests passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
