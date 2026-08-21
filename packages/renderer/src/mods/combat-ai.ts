import type { CombatSettings } from '@dofemu/shared'
import {
  castSpell,
  finishTurn,
  getMyFighterId,
  isFightStarted,
  pickTarget,
  setFightReady
} from '@/scripts/fight-bridge'
import type { DofusWindow } from '@/types/dofus-window'

/**
 * Plays a fight turn on its own: cast the configured spell combo on a target,
 * then end the turn. It reads the settings on every turn, so edits in the UI
 * apply to the next turn without restarting anything.
 */

interface EventSourceLike {
  on: (event: string, cb: (...args: unknown[]) => void) => void
  removeListener?: (event: string, cb: (...args: unknown[]) => void) => void
  off?: (event: string, cb: (...args: unknown[]) => void) => void
}

export interface CombatAiCallbacks {
  getSettings: () => CombatSettings
  onLog?: (message: string) => void
}

interface TurnMessage {
  id?: number
}

function addListener(
  source: EventSourceLike | undefined,
  event: string,
  handler: (...args: unknown[]) => void,
  cleanups: Array<() => void>
) {
  if (!source?.on) return
  source.on(event, handler)
  cleanups.push(() => {
    if (source.removeListener) source.removeListener(event, handler)
    else source.off?.(event, handler)
  })
}

export function initCombatAi(
  gameWindow: DofusWindow,
  tabId: string,
  callbacks: CombatAiCallbacks
): () => void {
  const cleanups: Array<() => void> = []
  const connectionManager = gameWindow.dofus?.connectionManager as EventSourceLike | undefined
  const gui = gameWindow.gui as unknown as EventSourceLike | undefined

  let disposed = false
  let playing = false
  let lastTurnHandledAt = 0

  const log = (message: string) => callbacks.onLog?.(`[${tabId.slice(0, 6)}] ${message}`)

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)))

  const isMyTurn = (id: number | undefined) => {
    const myId = getMyFighterId(gameWindow)
    return myId !== null && id === myId
  }

  const playTurn = async () => {
    const settings = callbacks.getSettings()

    if (settings.combo.length === 0) {
      log('No spell in the combo, ending the turn')
      if (settings.endTurnAfterCombo) finishTurn(gameWindow)
      return
    }

    await sleep(settings.turnStartDelayMs)

    for (const spell of settings.combo) {
      if (disposed || !isFightStarted(gameWindow)) return

      const target = pickTarget(gameWindow, settings.targetStrategy)
      if (!target || target.cellId === null) {
        log('No reachable target, stopping the combo')
        break
      }

      try {
        castSpell(gameWindow, spell.id, target.cellId)
        log(`Cast ${spell.name || spell.id} on ${target.name ?? target.id}`)
      } catch (err) {
        log(`Cast failed: ${err instanceof Error ? err.message : String(err)}`)
        break
      }

      await sleep(settings.castDelayMs)
    }

    if (disposed) return
    if (settings.endTurnAfterCombo) {
      finishTurn(gameWindow)
      log('Turn ended')
    }
  }

  const onTurnStart = (...args: unknown[]) => {
    const message = args[0] as TurnMessage
    if (disposed || playing) return
    if (!callbacks.getSettings().enabled) return
    if (!isMyTurn(message?.id)) return

    // The same turn can be announced on both emitters.
    const now = Date.now()
    if (now - lastTurnHandledAt < 500) return
    lastTurnHandledAt = now

    playing = true
    playTurn()
      .catch((err) => log(`Turn failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        playing = false
      })
  }

  const onFightStart = () => {
    const settings = callbacks.getSettings()
    if (disposed || !settings.enabled || !settings.autoReady) return
    try {
      setFightReady(gameWindow, true)
      log('Ready for the fight')
    } catch {}
  }

  for (const source of [gui, connectionManager]) {
    addListener(source, 'GameFightTurnStartMessage', onTurnStart, cleanups)
    addListener(source, 'GameFightStartingMessage', onFightStart, cleanups)
  }

  return () => {
    disposed = true
    for (const cleanup of cleanups) cleanup()
    cleanups.length = 0
  }
}
