import type { DofusWindow } from '@/types/dofus-window'

/**
 * Closing the screens the game puts up on its own — the fight results and the
 * level-up window — which otherwise block anything the next map would need.
 *
 * Window ids differ between builds, so a window is matched by a normalised
 * substring of its id rather than an exact name, and several close entry
 * points are tried before falling back to clicking the close button.
 */

type Dict = Record<string, unknown>

export const DEFAULT_POPUP_PATTERNS = [
  'fightend',
  'levelup',
  'newlevel',
  'levelgain',
  'craftresult'
]

/** DOM classes used by the same screens, for the click fallback. */
const DOM_SELECTORS = [
  '.FightEndUi',
  '.fightEndUi',
  '.LevelUpPopup',
  '.levelUpPopup',
  '.levelUp'
]

const CLOSE_BUTTON_SELECTORS = ['.closeButton', '.close', '.buttonOk', '.okButton', '.confirmButton']

function asDict(value: unknown): Dict | null {
  return value && typeof value === 'object' ? (value as Dict) : null
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function matches(id: string, patterns: string[]): boolean {
  const normalised = normalise(id)
  return patterns.some((pattern) => normalised.includes(normalise(pattern)))
}

function call(target: unknown, method: string): boolean {
  const dict = asDict(target)
  const fn = dict?.[method]
  if (typeof fn !== 'function') return false
  try {
    ;(fn as () => void).call(dict)
    return true
  } catch {
    return false
  }
}

function getWindowsManager(gameWindow: DofusWindow): Dict | null {
  return asDict(asDict(gameWindow.gui)?.windowsManager)
}

/** Open windows as [id, window] pairs, across the shapes seen on game builds. */
function openWindows(manager: Dict | null): Array<[string, unknown]> {
  if (!manager) return []

  for (const key of ['openedWindows', '_openedWindows', 'windows', '_windowList']) {
    const container = manager[key]
    if (!container) continue

    if (container instanceof Map) {
      return [...container.entries()].map(([id, win]) => [String(id), win])
    }
    if (Array.isArray(container)) {
      return container
        .map((win): [string, unknown] => [String(asDict(win)?.id ?? ''), win])
        .filter(([id]) => id.length > 0)
    }
    const dict = asDict(container)
    if (dict) return Object.entries(dict)
  }

  return []
}

function isVisible(win: unknown): boolean {
  const dict = asDict(win)
  if (!dict) return false
  if (typeof dict.isVisible === 'function') {
    try {
      return (dict.isVisible as () => boolean).call(dict) !== false
    } catch {
      return true
    }
  }
  if (typeof dict.openState === 'boolean') return dict.openState
  return true
}

/**
 * Closes the game screens matching `patterns`.
 * Returns what was closed, for logging.
 */
export function closeUiPopups(
  gameWindow: DofusWindow,
  patterns: string[] = DEFAULT_POPUP_PATTERNS
): string[] {
  const closed: string[] = []
  const manager = getWindowsManager(gameWindow)

  for (const [id, win] of openWindows(manager)) {
    if (!matches(id, patterns) || !isVisible(win)) continue

    let done = false
    const close = manager?.close
    if (typeof close === 'function') {
      try {
        ;(close as (id: string) => void).call(manager, id)
        done = true
      } catch {}
    }
    if (!done) done = call(win, 'close') || call(win, 'hide')
    if (done) closed.push(id)
  }

  // Some builds keep the fight results outside the window manager.
  const gui = asDict(gameWindow.gui)
  for (const key of ['fightEndUi', 'levelUpPopup']) {
    const ui = gui?.[key]
    if (!ui || !isVisible(ui)) continue
    if (call(ui, 'close') || call(ui, 'hide')) closed.push(key)
  }

  if (closed.length > 0) return closed

  // Last resort: click the close button of the screen in the DOM.
  try {
    for (const selector of DOM_SELECTORS) {
      for (const element of gameWindow.document.querySelectorAll(selector)) {
        const host = element as HTMLElement
        if (host.offsetParent === null) continue
        for (const buttonSelector of CLOSE_BUTTON_SELECTORS) {
          const button = host.querySelector(buttonSelector) as HTMLElement | null
          if (button) {
            button.click()
            closed.push(`${selector}${buttonSelector}`)
            break
          }
        }
      }
    }
  } catch {}

  return closed
}
