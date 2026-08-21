import nodePath from 'path'

/**
 * Resolves a request path under `basePath`, or null when it escapes it.
 *
 * The comparison has to survive Windows: `basePath` is built with a trailing
 * "/" while `resolve` returns "\\" separators, so comparing the raw strings
 * rejected every file there. Both sides are resolved before comparing, and the
 * separator is appended explicitly so "…/game-old" does not match "…/game".
 *
 * `pathApi` is only injected by the tests, to exercise win32 rules on Linux.
 */
export function resolveStaticPath(
  basePath: string,
  requestPath: string,
  pathApi: typeof nodePath = nodePath
): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(requestPath)
  } catch {
    return null
  }

  if (decoded.includes('\0')) return null

  const root = pathApi.resolve(basePath)
  const target = pathApi.resolve(root, `.${pathApi.sep}${decoded}`)

  if (target !== root && !target.startsWith(root + pathApi.sep)) return null
  return target
}
