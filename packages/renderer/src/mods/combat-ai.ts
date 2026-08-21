import type { CombatSettings, CombatSpell } from '@dofemu/shared'
import { closeUiPopups } from '@/scripts/ui-bridge'
import {
  castSpell,
  cellDistance,
  findApproachCell,
  finishTurn,
  getMyFighter,
  getMyFighterId,
  getSpellRange,
  isFightStarted,
  pickTarget,
  setFightReady
} from '@/scripts/fight-bridge'
import { requestMoveToCell } from '@/scripts/game-bridge'
import type { DofusWindow } from '@/types/dofus-window'

/**
 * Plays a fight turn on its own: cast the configured spell combo on a target,
 * then end the turn. It reads the settings on every turn, so edits in the UI
 * apply to the next turn without restarting anything.
 *
 * A turn can run its own combo: `turnCombos` replaces the default one on the
 * turn it names, so an opener (buffs, positioning) differs from the rest.
 *
 * When a target is out of range, the remaining movement points are used to
 * close in before casting.
 *
 * When a fight ends it also closes the results screen and the level-up window,
 * which would otherwise block whatever runs next. The level-up window can
 * arrive a moment after the results, so the sweep is repeated a few times.
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

/** The level-up window can land after the results screen, so sweep a few times. */
const DISMISS_DELAYS_MS = [800, 2000, 4500]

/** How long to wait for a fight move to land before casting anyway. */
const MOVE_TIMEOUT_MS = 6000
const MOVE_POLL_MS = 200

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
  /** Fighter whose turn start we last saw, to ignore duplicate emissions. */
  let lastTurnOwner: number | null = null
  /** Our own turn number in the current fight, starting at 1. */
  let myTurn = 0

  const log = (message: string) => callbacks.onLog?.(`[${tabId.slice(0, 6)}] ${message}`)

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)))

  const isMyTurn = (id: number | undefined) => {
    const myId = getMyFighterId(gameWindow)
    return myId !== null && id === myId
  }

  /** Combo to play on `turn`: the override for that turn, or the default one. */
  const comboForTurn = (settings: CombatSettings, turn: number): { combo: CombatSpell[]; label: string } => {
    const override = (settings.turnCombos ?? []).find((entry) => entry.turn === turn)
    if (override) return { combo: override.combo, label: `turn ${turn} combo` }
    return { combo: settings.combo, label: 'default combo' }
  }

  const waitForMove = async (targetCell: number) => {
    const deadline = Date.now() + MOVE_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (disposed) return
      const me = getMyFighter(gameWindow)
      if (me?.cellId === targetCell) return
      await sleep(MOVE_POLL_MS)
    }
  }

  /** Walks towards `target` with the movement points left, when out of range. */
  const approach = async (settings: CombatSettings, spell: CombatSpell, targetCell: number) => {
    if (!settings.approachEnemies) return

    const me = getMyFighter(gameWindow)
    if (!me || me.cellId === null) return

    const range = getSpellRange(gameWindow, spell.id) ?? settings.defaultSpellRange
    if (cellDistance(me.cellId, targetCell) <= range) return

    const movementPoints = me.mp ?? 0
    if (movementPoints <= 0) {
      log('Out of range with no MP left')
      return
    }

    const target = pickTarget(gameWindow, settings.targetStrategy)
    if (!target) return

    const cell = findApproachCell(gameWindow, target, range, movementPoints)
    if (cell === null) {
      log(`Cannot get within ${range} cell(s) of the target with ${movementPoints} MP`)
      return
    }

    log(`Moving to cell ${cell} to reach the target (${movementPoints} MP)`)
    if (!requestMoveToCell(gameWindow, cell)) {
      log('No movement entry point on this game build')
      return
    }

    await waitForMove(cell)
  }

  const playTurn = async (turn: number) => {
    const settings = callbacks.getSettings()
    const { combo, label } = comboForTurn(settings, turn)

    if (combo.length === 0) {
      log(`Turn ${turn}: ${label} is empty, passing`)
      if (settings.endTurnAfterCombo) finishTurn(gameWindow)
      return
    }

    log(`Turn ${turn}: playing the ${label}`)
    await sleep(settings.turnStartDelayMs)

    for (const spell of combo) {
      if (disposed || !isFightStarted(gameWindow)) return

      let target = pickTarget(gameWindow, settings.targetStrategy)
      if (!target || target.cellId === null) {
        log('No reachable target, stopping the combo')
        break
      }

      await approach(settings, spell, target.cellId)
      if (disposed || !isFightStarted(gameWindow)) return

      // The target may have been re-evaluated while moving.
      target = pickTarget(gameWindow, settings.targetStrategy) ?? target
      if (target.cellId === null) break

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
    const fighterId = message?.id
    if (fighterId === undefined) return

    // Both emitters announce the same turn; only the first one counts.
    const duplicate = fighterId === lastTurnOwner
    lastTurnOwner = fighterId

    if (disposed || playing || duplicate) return
    if (!callbacks.getSettings().enabled) return
    if (!isMyTurn(fighterId)) return

    myTurn += 1
    playing = true
    playTurn(myTurn)
      .catch((err) => log(`Turn failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        playing = false
      })
  }

  const onTurnEnd = () => {
    lastTurnOwner = null
  }

  const onFightEnd = () => {
    myTurn = 0
    lastTurnOwner = null
    if (disposed || !callbacks.getSettings().closeEndScreens) return

    for (const delay of DISMISS_DELAYS_MS) {
      const timer = setTimeout(() => {
        if (disposed || !callbacks.getSettings().closeEndScreens) return
        try {
          const closed = closeUiPopups(gameWindow)
          if (closed.length > 0) log(`Closed ${closed.join(', ')}`)
        } catch (err) {
          log(`Could not close the end screens: ${err instanceof Error ? err.message : String(err)}`)
        }
      }, delay)
      cleanups.push(() => clearTimeout(timer))
    }
  }

  const onFightStart = () => {
    myTurn = 0
    lastTurnOwner = null
    const settings = callbacks.getSettings()
    if (disposed || !settings.enabled || !settings.autoReady) return
    try {
      setFightReady(gameWindow, true)
      log('Ready for the fight')
    } catch {}
  }

  for (const source of [gui, connectionManager]) {
    addListener(source, 'GameFightTurnStartMessage', onTurnStart, cleanups)
    addListener(source, 'GameFightTurnEndMessage', onTurnEnd, cleanups)
    addListener(source, 'GameFightStartingMessage', onFightStart, cleanups)
    addListener(source, 'GameFightEndMessage', onFightEnd, cleanups)
  }

  return () => {
    disposed = true
    for (const cleanup of cleanups) cleanup()
    cleanups.length = 0
  }
}
