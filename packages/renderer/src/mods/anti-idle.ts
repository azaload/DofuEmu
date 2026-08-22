import type { GameSettings } from '@dofemu/shared'
import { findByLabel, screenHasText } from '@/scripts/dom'
import type { DofusWindow } from '@/types/dofus-window'

/**
 * Keeps the session alive while the bot plays.
 *
 * The client counts inactivity from real mouse and keyboard input, which a
 * script never produces: after a while it puts up "Une inactivité prolongée
 * entraîne une déconnexion automatique" and, left alone, the server drops the
 * connection. So a little synthetic input is fed to the game window, and the
 * dialog is closed whenever it slips through.
 */

const INACTIVITY_TEXT = /inactivit|inactivity|deconnexion automatique|automatic disconnect/i
const CONFIRM_LABEL = /^(ok|oui|yes|continuer|continue|fermer|close)$/i

/** How often the dialog is looked for, whatever the activity interval is. */
const DIALOG_POLL_MS = 5000

export interface AntiIdleCallbacks {
  getSettings: () => GameSettings
  onLog?: (message: string) => void
}

/** Closes the inactivity warning if it is up. Returns true when one was closed. */
export function dismissInactivityDialog(gameWindow: DofusWindow): boolean {
  if (!screenHasText(gameWindow, INACTIVITY_TEXT)) return false

  const button = findByLabel(gameWindow, CONFIRM_LABEL, 20)
  if (!button) return false

  try {
    button.click()
    return true
  } catch {
    return false
  }
}

/**
 * Feeds the game a sign of life: a pointer move over the canvas and a modifier
 * key press. Neither does anything in game — no click, no character input —
 * but both count as activity for the client.
 */
export function signalActivity(gameWindow: DofusWindow): void {
  try {
    const target = gameWindow.document.body
    if (!target) return

    const x = 8 + Math.floor(Math.random() * 32)
    const y = 8 + Math.floor(Math.random() * 32)

    for (const type of ['mousemove', 'pointermove'] as const) {
      target.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })
      )
    }

    for (const type of ['keydown', 'keyup'] as const) {
      target.dispatchEvent(
        new KeyboardEvent(type, { bubbles: true, cancelable: true, key: 'Shift', code: 'ShiftLeft' })
      )
    }
  } catch {}
}

export function initAntiIdle(
  gameWindow: DofusWindow,
  tabId: string,
  callbacks: AntiIdleCallbacks
): () => void {
  let disposed = false
  const log = (message: string) => callbacks.onLog?.(`[${tabId.slice(0, 6)}] ${message}`)

  // Re-scheduled every time, so a change to the interval applies at once.
  let activityTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleActivity = () => {
    const settings = callbacks.getSettings()
    const seconds = Math.min(600, Math.max(10, settings.antiIdleIntervalSec || 45))
    activityTimer = setTimeout(() => {
      if (disposed) return
      if (callbacks.getSettings().antiIdleEnabled) signalActivity(gameWindow)
      scheduleActivity()
    }, seconds * 1000)
  }
  scheduleActivity()

  const watcher = setInterval(() => {
    if (disposed) return
    if (!callbacks.getSettings().antiIdleEnabled) return
    if (dismissInactivityDialog(gameWindow)) {
      log('Closed the inactivity warning')
      signalActivity(gameWindow)
    }
  }, DIALOG_POLL_MS)

  return () => {
    disposed = true
    if (activityTimer) clearTimeout(activityTimer)
    clearInterval(watcher)
  }
}
