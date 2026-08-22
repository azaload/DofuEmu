import type { CombatSettings, CombatSpell } from '@dofemu/shared'
import { closeUiPopups } from '@/scripts/ui-bridge'
import {
  areCellsAligned,
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
const MOVE_TIMEOUT_MS = 4000
const MOVE_POLL_MS = 60
/** How long to wait for a walk to start before calling it refused. */
const MOVE_START_TIMEOUT_MS = 700
/** A position held this long means the walk is over. */
const MOVE_SETTLE_MS = 250
/** How many times to re-try closing in during one spell. */
const MAX_APPROACH_STEPS = 2

/** How long to wait for the server to declare our turn playable. */
const TURN_PLAYABLE_TIMEOUT_MS = 2500
/** How long to wait for the running animation sequence to finish. */
const SEQUENCE_TIMEOUT_MS = 2500
const IDLE_POLL_MS = 50

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
  /** Fighter whose turn start we last saw, to ignore duplicate emissions. */
  let lastTurnOwner: number | null = null
  /** Our own turn number in the current fight, starting at 1. */
  let myTurn = 0
  /**
   * Bumped on every turn boundary. Actions captured a token and stop when it
   * changes, so nothing from a finished turn is sent late.
   */
  let turnToken = 0
  /** Server said our turn can be played. */
  let turnPlayable = false
  /** Animation sequences in flight; acting during one wedges the client. */
  let sequenceDepth = 0

  const log = (message: string) => callbacks.onLog?.(`[${tabId.slice(0, 6)}] ${message}`)

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)))

  /** Waits for `check` to hold, giving up after `timeout` so we never hang. */
  const waitFor = async (check: () => boolean, timeout: number): Promise<boolean> => {
    const deadline = Date.now() + timeout
    while (!check()) {
      if (disposed || Date.now() >= deadline) return false
      await sleep(IDLE_POLL_MS)
    }
    return true
  }

  /**
   * Waits for the running animation sequence to finish. A sequence that never
   * ends resets the counter, so one missed message cannot slow every later
   * action down.
   */
  const waitForIdle = async () => {
    if (sequenceDepth <= 0) return
    const idle = await waitFor(() => sequenceDepth <= 0, SEQUENCE_TIMEOUT_MS)
    if (!idle) {
      log('The animation sequence did not end in time, continuing')
      sequenceDepth = 0
    }
  }

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

  const currentCell = () => getMyFighter(gameWindow)?.cellId ?? null

  /**
   * Follows a move request to its end. The engine walks as far as it can, which
   * is not always the cell we asked for, so the outcome is reported instead of
   * being assumed.
   */
  const waitForMove = async (
    targetCell: number
  ): Promise<'arrived' | 'stopped-short' | 'no-move'> => {
    const start = currentCell()

    // Wait for the walk to begin.
    const startDeadline = Date.now() + MOVE_START_TIMEOUT_MS
    let moving = false
    while (Date.now() < startDeadline) {
      if (disposed) return 'no-move'
      const cell = currentCell()
      if (cell === targetCell) return 'arrived'
      if (cell !== start) {
        moving = true
        break
      }
      await sleep(MOVE_POLL_MS)
    }
    if (!moving) return 'no-move'

    // Then for it to settle.
    const deadline = Date.now() + MOVE_TIMEOUT_MS
    let last = currentCell()
    let stableSince = Date.now()
    while (Date.now() < deadline) {
      if (disposed) return 'stopped-short'
      const cell = currentCell()
      if (cell === targetCell) return 'arrived'
      if (cell !== last) {
        last = cell
        stableSince = Date.now()
      } else if (Date.now() - stableSince > MOVE_SETTLE_MS) {
        return 'stopped-short'
      }
      await sleep(MOVE_POLL_MS)
    }
    return 'stopped-short'
  }

  /** Range to assume for a spell: the one set on it, the game's, then the fallback. */
  const rangeFor = (settings: CombatSettings, spell: CombatSpell): { range: number; source: string } => {
    if (typeof spell.range === 'number' && spell.range >= 0) {
      return { range: spell.range, source: 'spell setting' }
    }
    const fromGame = getSpellRange(gameWindow, spell.id)
    if (fromGame !== null) return { range: fromGame, source: 'game data' }
    return { range: settings.defaultSpellRange, source: 'fallback' }
  }

  /**
   * Walks towards `target` with the movement points left: to get in range, or
   * as close as possible when the target is further than that.
   *
   * The engine can stop short of the cell we asked for, so the walk is repeated
   * while it makes progress and there are points left.
   */
  const approach = async (settings: CombatSettings, spell: CombatSpell, targetCell: number) => {
    if (!settings.approachEnemies) return

    const { range, source } = rangeFor(settings, spell)

    for (let step = 0; step < MAX_APPROACH_STEPS; step++) {
      const me = getMyFighter(gameWindow)
      if (!me || me.cellId === null) return

      const distance = cellDistance(me.cellId, targetCell)
      const inRange = distance <= range
      const aligned = areCellsAligned(me.cellId, targetCell)
      if (inRange && (!settings.preferLineUp || aligned)) return

      const movementPoints = me.mp ?? 0
      if (movementPoints <= 0) {
        if (!inRange) {
          log(`Target ${distance} cell(s) away, range ${range} (${source}), no MP left`)
        }
        return
      }

      const target = pickTarget(gameWindow, settings.targetStrategy)
      if (!target) return

      const move = findApproachCell(gameWindow, target, range, movementPoints, {
        preferLineUp: settings.preferLineUp
      })

      if (!move) {
        if (!inRange) {
          log(`Target ${distance} cell(s) away, range ${range} (${source}), nowhere better within ${movementPoints} MP`)
        }
        return
      }

      log(
        `Moving to cell ${move.cellId} (${move.cost} MP of ${movementPoints}, target ${distance} cell(s) away, range ${range} from ${source})`
      )

      if (!requestMoveToCell(gameWindow, move.cellId)) {
        log('No movement entry point on this game build')
        return
      }

      const outcome = await waitForMove(move.cellId)
      await waitForIdle()

      const landed = currentCell()
      if (outcome === 'no-move') {
        log('The character did not move — the path is blocked')
        return
      }
      if (outcome === 'stopped-short') {
        log(`Stopped on cell ${landed} instead of ${move.cellId}`)
        if (landed === me.cellId) return
      }
    }
  }

  const playTurn = async (turn: number, token: number) => {
    const settings = callbacks.getSettings()
    const { combo, label } = comboForTurn(settings, turn)
    const stillOurTurn = () => !disposed && turnToken === token

    // Acting before the server declares the turn playable is ignored at best,
    // and wedges the fight at worst.
    if (!turnPlayable) {
      const ready = await waitFor(() => turnPlayable || !stillOurTurn(), TURN_PLAYABLE_TIMEOUT_MS)
      if (!ready && stillOurTurn()) {
        log('The turn was never announced as playable, acting anyway')
      }
    }
    if (!stillOurTurn()) return

    await waitForIdle()
    if (!stillOurTurn()) return

    if (combo.length === 0) {
      log(`Turn ${turn}: ${label} is empty, passing`)
      if (settings.endTurnAfterCombo) finishTurn(gameWindow)
      return
    }

    log(`Turn ${turn}: playing the ${label}`)
    await sleep(settings.turnStartDelayMs)

    for (const spell of combo) {
      if (!stillOurTurn() || !isFightStarted(gameWindow)) return

      // Spells flagged "on me" need no target and no approach.
      if (spell.self) {
        const me = getMyFighter(gameWindow)
        if (!me || me.cellId === null) {
          log(`Cannot cast ${spell.name || spell.id} on myself: unknown position`)
          continue
        }
        try {
          castSpell(gameWindow, spell.id, me.cellId)
          log(`Cast ${spell.name || spell.id} on myself`)
        } catch (err) {
          log(`Cast failed: ${err instanceof Error ? err.message : String(err)}`)
          break
        }
        await sleep(settings.castDelayMs)
        await waitForIdle()
        continue
      }

      let target = pickTarget(gameWindow, settings.targetStrategy)
      if (!target || target.cellId === null) {
        log('No reachable target, stopping the combo')
        break
      }

      await approach(settings, spell, target.cellId)
      if (!stillOurTurn() || !isFightStarted(gameWindow)) return

      // The target may have been re-evaluated while moving.
      target = pickTarget(gameWindow, settings.targetStrategy) ?? target
      if (target.cellId === null) break

      try {
        castSpell(gameWindow, spell.id, target.cellId)
        const me = getMyFighter(gameWindow)
        const distance =
          me?.cellId !== null && me?.cellId !== undefined && target.cellId !== null
            ? cellDistance(me.cellId, target.cellId)
            : null
        log(
          `Cast ${spell.name || spell.id} on ${target.name ?? target.id}` +
            (distance !== null ? ` from ${distance} cell(s)` : '')
        )
      } catch (err) {
        log(`Cast failed: ${err instanceof Error ? err.message : String(err)}`)
        break
      }

      await sleep(settings.castDelayMs)
      // Let the spell animation play out before the next action.
      await waitForIdle()
    }

    if (!stillOurTurn()) return
    if (settings.endTurnAfterCombo) {
      // Ending the turn mid-sequence leaves the client waiting forever.
      await waitForIdle()
      if (!stillOurTurn()) return
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

    if (duplicate) return

    // A new turn: anything still running belongs to the previous one.
    turnToken += 1
    turnPlayable = false

    if (disposed) return
    if (!callbacks.getSettings().enabled) return
    if (!isMyTurn(fighterId)) return

    // A run left over from the previous turn stops on its own: it is bound to
    // the token bumped above. Never skip a turn because of it.
    myTurn += 1
    playTurn(myTurn, turnToken).catch((err) =>
      log(`Turn failed: ${err instanceof Error ? err.message : String(err)}`)
    )
  }

  const onTurnEnd = () => {
    lastTurnOwner = null
    turnPlayable = false
    turnToken += 1
  }

  const onTurnPlaying = () => {
    turnPlayable = true
  }

  const onSequenceStart = () => {
    sequenceDepth += 1
  }

  const onSequenceEnd = () => {
    sequenceDepth = Math.max(0, sequenceDepth - 1)
  }

  const onFightEnd = () => {
    myTurn = 0
    lastTurnOwner = null
    turnPlayable = false
    sequenceDepth = 0
    turnToken += 1
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
    turnPlayable = false
    sequenceDepth = 0
    turnToken += 1
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
    addListener(source, 'GameFightTurnStartPlayingMessage', onTurnPlaying, cleanups)
    addListener(source, 'SequenceStartMessage', onSequenceStart, cleanups)
    addListener(source, 'SequenceEndMessage', onSequenceEnd, cleanups)
    addListener(source, 'GameFightStartingMessage', onFightStart, cleanups)
    addListener(source, 'GameFightEndMessage', onFightEnd, cleanups)
  }

  return () => {
    disposed = true
    for (const cleanup of cleanups) cleanup()
    cleanups.length = 0
  }
}
