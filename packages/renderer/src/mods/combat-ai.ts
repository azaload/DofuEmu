import type { CombatSettings, CombatSpell } from '@dofemu/shared'
import { closeUiPopups } from '@/scripts/ui-bridge'
import {
  buildFightState,
  deriveChallengeRules,
  readChallengeTexts,
  type FightChallenge
} from '@/scripts/fight-state'
import { planTurnWithOllama } from '@/scripts/ollama-planner'
import {
  areCellsAligned,
  castSpell,
  cellDistance,
  findPositionCell,
  sendFightMove,
  sendPlacementMove,
  tacklingEnemies,
  choosePlacementCell,
  finishTurn,
  getEnemies,
  getFighters,
  getMyFighter,
  getMyFighterId,
  getSpellRange,
  isFightStarted,
  pickTarget,
  targetsInRange,
  setFightReady
} from '@/scripts/fight-bridge'
import { requestMoveToCell } from '@/scripts/game-bridge'
import { reachableCells } from '@/scripts/cells'
import { planTurn as planSpellTurn } from '@/scripts/spell-planner'
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
  /** Turns this build failed to announce; past two, the wait is dropped. */
  let missedPlayableAnnouncements = 0
  /** Animation sequences in flight; acting during one wedges the client. */
  let sequenceDepth = 0
  /** Challenges of the current fight, from its messages and its panel. */
  let challenges: FightChallenge[] = []
  /** Starting cells the placement phase offers. */
  let placementCells: number[] = []
  let placed = false
  /** Turn each spell was last cast on, so a cooldown is respected. */
  let lastCastTurn = new Map<number, number>()

  const log = (message: string) => callbacks.onLog?.(`[${tabId.slice(0, 6)}] ${message}`)

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)))

  /**
   * A pause with a random tail, so two actions are never the same distance
   * apart. Acting on the exact millisecond is what makes the client sit on
   * "waiting for..." and what reads as a machine playing.
   */
  const humanSleep = (base: number) => {
    const jitter = Math.max(0, callbacks.getSettings().randomJitterMs ?? 0)
    return sleep(Math.max(0, base) + Math.floor(Math.random() * (jitter + 1)))
  }

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
   * Range every spell of the combo can be cast from: the shortest one, so the
   * whole combo still reaches from where we end up.
   */
  const comboRange = (settings: CombatSettings, combo: CombatSpell[]) => {
    const ranges = combo
      .filter((spell) => !spell.self)
      .map((spell) => rangeFor(settings, spell))
    if (ranges.length === 0) return null
    return ranges.reduce((shortest, candidate) =>
      candidate.range < shortest.range ? candidate : shortest
    )
  }

  /**
   * Places the character for the turn — once, before casting anything.
   *
   * One move, followed to its end: asking again while the engine is still
   * walking is what made the character crawl one cell at a time.
   */
  const positionForTurn = async (settings: CombatSettings, combo: CombatSpell[]) => {
    if (!settings.approachEnemies) return

    const spellRange = comboRange(settings, combo)
    if (!spellRange) return

    const me = getMyFighter(gameWindow)
    if (!me || me.cellId === null) return

    const movementPoints = me.mp ?? 0
    const target = pickTarget(gameWindow, settings.targetStrategy)
    if (!target || target.cellId === null) return

    const distance = cellDistance(me.cellId, target.cellId)
    const { range, source } = spellRange

    if (movementPoints <= 0) {
      if (distance > range) log(`Target ${distance} cell(s) away, range ${range} (${source}), no MP left`)
      return
    }

    const tacklers = tacklingEnemies(getEnemies(gameWindow), me.cellId)

    const move = findPositionCell(gameWindow, target, range, movementPoints, {
      preferLineUp: settings.preferLineUp,
      positioning: settings.positioning,
      tackleAware: settings.tackleAware
    })

    if (!move) {
      if (tacklers.length > 0 && settings.tackleAware) {
        log(`Held by ${tacklers.length} monster(s) in contact: not moving, casting from here`)
      } else if (distance > range) {
        log(`Target ${distance} cell(s) away, range ${range} (${source}), nowhere better within ${movementPoints} MP`)
      }
      return
    }

    const intent =
      settings.positioning === 'keep-distance'
        ? `keeping ${move.distanceToClosestEnemy} cell(s) from the closest enemy`
        : `closing to ${move.distanceToTarget} cell(s)`
    const escaping = tacklers.length > 0 ? `, breaking away from ${tacklers.length} monster(s)` : ''
    log(
      `Moving to cell ${move.cellId}: ${move.cost} of ${movementPoints} MP, ${intent}${escaping}` +
        (move.aligned ? ', lined up' : '') +
        ` (range ${range} from ${source})`
    )

    const apBefore = me.ap ?? null

    // In a fight the move has to reach the server: an engine helper only walks
    // the sprite, and the character is rolled back where it stood.
    const sent = sendFightMove(gameWindow, move.path)
    if (!sent && !requestMoveToCell(gameWindow, move.cellId)) {
      log('No way to move on this build — run api.inspect() from a script')
      return
    }

    const outcome = await waitForMove(move.cellId)
    await waitForIdle()
    await humanSleep(0)

    // The server has the last word: if it refused, the character is back where
    // it started and the points were never spent.
    const landedOn = currentCell()
    if (landedOn === me.cellId) {
      log(
        sent
          ? `The server refused the move to cell ${move.cellId} — back on ${landedOn}`
          : `The move to cell ${move.cellId} was local only — back on ${landedOn}`
      )
      return
    }

    if (outcome === 'no-move') {
      log('The character did not move — blocked, or the engine refused the path')
      return
    }
    if (outcome === 'stopped-short') {
      log(`Stopped on cell ${currentCell()} instead of ${move.cellId} — the way is blocked`)
    }

    // What the tackle actually cost, which no formula here can predict.
    const after = getMyFighter(gameWindow)
    if (after?.cellId !== null && after?.cellId !== undefined) {
      const walked = cellDistance(me.cellId, after.cellId)
      const mpSpent = movementPoints - (after.mp ?? 0)
      const apLost = apBefore !== null && after.ap !== null ? apBefore - after.ap : 0

      if (tacklers.length > 0 && (mpSpent > walked || apLost > 0)) {
        log(
          `Tackled on the way out: ${mpSpent} MP for ${walked} cell(s)` +
            (apLost > 0 ? `, and ${apLost} AP lost` : '')
        )
      }
      if (tacklers.length > 0 && tacklingEnemies(getEnemies(gameWindow), after.cellId).length > 0) {
        log('Still in contact after the move')
      }
    }
  }

  /** The steps to walk from `from` to `to`, or null when nothing legal leads there. */
  const reachablePath = (from: number | null, to: number): number[] | null => {
    if (from === null) return null
    const me = getMyFighter(gameWindow)
    const occupied = new Set(
      getFighters(gameWindow)
        .filter((fighter) => fighter.alive && fighter.cellId !== null && fighter.cellId !== from)
        .map((fighter) => fighter.cellId as number)
    )
    return reachableCells(gameWindow, from, me?.mp ?? 0, occupied).get(to)?.path ?? null
  }

  /**
   * Hands the turn to the local model. Returns false when it could not be
   * used — no answer, no usable action — so the rules play the turn instead.
   */
  const playWithModel = async (
    settings: CombatSettings,
    combo: CombatSpell[],
    turn: number,
    stillOurTurn: () => boolean
  ): Promise<'played' | 'no-cast' | 'unavailable'> => {
    const state = buildFightState(gameWindow, {
      turn,
      combo,
      fallbackRange: settings.defaultSpellRange,
      tackleAware: settings.tackleAware,
      challenges: withChallengeTexts()
    })

    if (state.challenges.length > 0) {
      log(
        `Challenges: ${state.challenges
          .map((challenge) => challenge.name ?? `#${challenge.id}`)
          .join(', ')}`
      )
    }

    let result
    try {
      result = await planTurnWithOllama(state, settings)
    } catch (err) {
      log(`Model unreachable (${err instanceof Error ? err.message : String(err)}), playing the rules`)
      return 'unavailable'
    }

    if (!stillOurTurn()) return 'played'

    if (result.error) {
      log(`Model: ${result.error} (${result.elapsedMs}ms), playing the rules`)
      return 'unavailable'
    }

    for (const rejected of result.rejected) log(`Model action dropped — ${rejected}`)

    if (result.actions.length === 0) {
      log(`Model returned nothing usable (${result.elapsedMs}ms), playing the rules`)
      return 'unavailable'
    }

    log(`Model plan in ${result.elapsedMs}ms: ${result.reason ?? result.actions.length + ' action(s)'}`)

    let casts = 0

    for (const action of result.actions) {
      if (!stillOurTurn() || !isFightStarted(gameWindow)) return 'played'

      if (action.type === 'move') {
        const cell = state.cells.find((candidate) => candidate.cellId === action.cellId)
        if (!cell) continue
        if (settings.tackleAware && tacklingEnemies(getEnemies(gameWindow), state.me.cellId ?? -1).length > 0) {
          log('Model asked to move while held in contact — skipped')
          continue
        }

        const path = reachablePath(state.me.cellId, cell.cellId)
        if (!path) {
          log(`No path to cell ${cell.cellId} — move skipped`)
          continue
        }

        log(`Moving to cell ${cell.cellId} (${cell.cost} MP, model)`)
        if (sendFightMove(gameWindow, path)) {
          await waitForMove(cell.cellId)
          await waitForIdle()
          await humanSleep(0)
        }
        continue
      }

      const target = action.targetId !== undefined
        ? getEnemies(gameWindow).find((enemy) => enemy.id === action.targetId)
        : getMyFighter(gameWindow)
      const cellId = target?.cellId ?? null
      if (cellId === null) continue

      try {
        castSpell(gameWindow, action.spellId, cellId)
        casts += 1
        log(`Cast ${action.spellId} on ${target?.name ?? target?.id ?? 'myself'} (model)`)
      } catch (err) {
        log(`Cast failed: ${err instanceof Error ? err.message : String(err)}`)
      }

      await humanSleep(settings.castDelayMs)
      await waitForIdle()
    }

    // A turn that only walks does not end a fight. The combo is played on top.
    return casts > 0 ? 'played' : 'no-cast'
  }

  /**
   * Throws a monster in contact away with a push spell.
   *
   * Fleeing on foot is tackled, but pushing the holder is not: with a single
   * enemy in contact this frees the character for the rest of the turn.
   */
  const breakMeleeWithPush = async (settings: CombatSettings, combo: CombatSpell[]) => {
    if (settings.positioning !== 'keep-distance') return

    const me = getMyFighter(gameWindow)
    if (!me || me.cellId === null) return

    const holders = tacklingEnemies(getEnemies(gameWindow), me.cellId)
    if (holders.length !== 1) return

    const push = combo.find((spell) => spell.push && !spell.self)
    if (!push) return

    const holder = holders[0]
    if (holder.cellId === null) return

    const { range } = rangeFor(settings, push)
    if (cellDistance(me.cellId, holder.cellId) > range) return

    try {
      castSpell(gameWindow, push.id, holder.cellId)
      log(`Pushing ${holder.name ?? holder.id} away with ${push.name || push.id} to break contact`)
    } catch (err) {
      log(`Push failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    await humanSleep(settings.castDelayMs)
    await waitForIdle()

    const after = getMyFighter(gameWindow)
    const stillHeld =
      after?.cellId !== null && after?.cellId !== undefined
        ? tacklingEnemies(getEnemies(gameWindow), after.cellId).length > 0
        : true
    log(stillHeld ? 'Still in contact after the push' : 'Contact broken, free to move')
  }

  /**
   * Plays the combo: each spell on the enemies it can reach, honouring the
   * challenge constraints. Shared by the rules and by the model path, which
   * falls back to it when its plan attacks no one.
   */
  const castCombo = async (
    settings: CombatSettings,
    combo: CombatSpell[],
    rules: ReturnType<typeof deriveChallengeRules>,
    stillOurTurn: () => boolean
  ) => {
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
        await humanSleep(settings.castDelayMs)
        await waitForIdle()
        continue
      }

      const { range } = rangeFor(settings, spell)

      // One cast each when several enemies are within reach, so a turn spreads
      // over the group instead of emptying itself on one target. With a single
      // enemy in reach this plays the combo as written.
      const reachable = targetsInRange(gameWindow, range, settings.targetStrategy)

      // A challenge naming one enemy, or asking for a single target, overrides
      // spreading the casts.
      const focused = rules.focusTargetId
        ? reachable.filter((enemy) => enemy.id === rules.focusTargetId)
        : reachable
      const allowed = rules.singleTarget || rules.focusTargetId ? focused.slice(0, 1) : focused

      const targets =
        settings.spreadCasts && !rules.singleTarget && !rules.focusTargetId && allowed.length > 1
          ? allowed
          : [allowed[0] ?? pickTarget(gameWindow, settings.targetStrategy)].filter(
              (fighter): fighter is NonNullable<typeof fighter> => !!fighter
            )

      if (targets.length === 0) {
        log('No target left, stopping the combo')
        break
      }

      for (const target of targets) {
        if (!stillOurTurn() || !isFightStarted(gameWindow)) return
        if (target.cellId === null) continue

        try {
          castSpell(gameWindow, spell.id, target.cellId)
          const me = getMyFighter(gameWindow)
          const distance =
            me?.cellId !== null && me?.cellId !== undefined
              ? cellDistance(me.cellId, target.cellId)
              : null
          log(
            `Cast ${spell.name || spell.id} on ${target.name ?? target.id}` +
              (distance !== null ? ` from ${distance} cell(s)` : '') +
              (targets.length > 1 ? ` (${targets.length} enemies in range)` : '')
          )
        } catch (err) {
          log(`Cast failed: ${err instanceof Error ? err.message : String(err)}`)
          break
        }

        await humanSleep(settings.castDelayMs)
        // Let the spell animation play out before the next action.
        await waitForIdle()
      }
    }
  }

  /**
   * Plays the turn from the character's own spells rather than a fixed combo:
   * boosts are kept up as their cooldown allows, then the cast that reaches the
   * most enemies is chained until the action points run out.
   */
  const castFromSpellbook = async (
    settings: CombatSettings,
    turn: number,
    rules: ReturnType<typeof deriveChallengeRules>,
    stillOurTurn: () => boolean
  ): Promise<number> => {
    const me = getMyFighter(gameWindow)
    if (!me || me.cellId === null) return 0

    const held = settings.tackleAware && tacklingEnemies(getEnemies(gameWindow), me.cellId).length > 0

    const plan = planSpellTurn(gameWindow, {
      turn,
      actionPoints: me.ap ?? 0,
      movementPoints: me.mp ?? 0,
      elements: settings.elements ?? [],
      lastCastTurn,
      canMove: settings.approachEnemies && !held && !rules.noMove,
      keepDistance: settings.positioning === 'keep-distance'
    })

    if (!plan) {
      log('Nothing to plan from the spellbook')
      return 0
    }

    if (plan.actions.length === 0) {
      log('No spell worth casting from here')
      return 0
    }

    let cast = 0

    // Moves and casts are played in the order the plan gives them: the points
    // can go before the first spell, between two of them, or nowhere.
    for (const action of plan.actions) {
      if (!stillOurTurn() || !isFightStarted(gameWindow)) break

      if (action.type === 'move') {
        log(`Moving to cell ${action.cellId} (${action.cost} MP) ${action.reason}`)
        if (sendFightMove(gameWindow, action.path)) {
          const outcome = await waitForMove(action.cellId)
          await waitForIdle()
          if (outcome === 'no-move') log('The move was refused, casting from here')
          await humanSleep(0)
        }
        continue
      }

      try {
        castSpell(gameWindow, action.spellId, action.cellId)
        lastCastTurn.set(action.spellId, turn)
        cast += 1
        log(
          `Cast ${action.name || action.spellId} on cell ${action.cellId}: ${action.reason}` +
            (action.apCost > 0 ? ` (${action.apCost} AP)` : '')
        )
      } catch (err) {
        log(`Cast failed: ${err instanceof Error ? err.message : String(err)}`)
        break
      }

      await humanSleep(settings.castDelayMs)
      await waitForIdle()
    }

    return cast
  }

  const playTurn = async (turn: number, token: number) => {
    const settings = callbacks.getSettings()
    const { combo, label } = comboForTurn(settings, turn)
    const stillOurTurn = () => !disposed && turnToken === token
    let turnPassed = false

    const passTurn = () => {
      if (turnPassed || !stillOurTurn() || !isFightStarted(gameWindow)) return
      turnPassed = true
      finishTurn(gameWindow)
      log('Turn ended')
    }

    try {
      await playCombo()
    } finally {
      // Whatever happened above — an early return, an error, a message we did
      // not expect — the turn is never left hanging.
      if (settings.endTurnAfterCombo) passTurn()
    }

    async function playCombo() {

    // Acting before the server declares the turn playable is ignored at best,
    // and wedges the fight at worst.
    if (!turnPlayable && missedPlayableAnnouncements < 2) {
      const ready = await waitFor(() => turnPlayable || !stillOurTurn(), TURN_PLAYABLE_TIMEOUT_MS)
      if (!ready && stillOurTurn()) {
        missedPlayableAnnouncements += 1
        log(
          missedPlayableAnnouncements >= 2
            ? 'This build never announces the turn: acting straight away from now on'
            : 'The turn was never announced as playable, acting anyway'
        )
      }
    }
    if (!stillOurTurn()) return

    await waitForIdle()
    if (!stillOurTurn()) return

    if (combo.length === 0) {
      log(`Turn ${turn}: ${label} is empty, passing`)
      return
    }

    log(`Turn ${turn}: playing the ${label}`)
    await humanSleep(settings.turnStartDelayMs)

    const rules = deriveChallengeRules(withChallengeTexts())
    if (rules.noMove) log('A challenge forbids moving: casting from here')

    if (settings.brain === 'ollama') {
      const outcome = await playWithModel(settings, combo, turn, stillOurTurn)
      if (outcome === 'played') return
      if (outcome === 'no-cast') {
        log('The model only moved: casting the combo on top')
        if (settings.spellMode === 'auto') {
      const cast = await castFromSpellbook(settings, turn, rules, stillOurTurn)
      if (cast === 0) await castCombo(settings, combo, rules, stillOurTurn)
    } else {
      await castCombo(settings, combo, rules, stillOurTurn)
    }
        return
      }
    }

    await breakMeleeWithPush(settings, combo)
    if (!stillOurTurn() || !isFightStarted(gameWindow)) return

    if (!rules.noMove && settings.spellMode !== 'auto') await positionForTurn(settings, combo)
    if (!stillOurTurn() || !isFightStarted(gameWindow)) return

    if (settings.spellMode === 'auto') {
      const cast = await castFromSpellbook(settings, turn, rules, stillOurTurn)
      if (cast === 0) await castCombo(settings, combo, rules, stillOurTurn)
    } else {
      await castCombo(settings, combo, rules, stillOurTurn)
    }

    if (!stillOurTurn()) return
    if (settings.endTurnAfterCombo) {
      // Ending the turn mid-sequence leaves the client waiting forever.
      await waitForIdle()
      passTurn()
    }
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

  const onTurnEnd = (...args: unknown[]) => {
    const fighterId = (args[0] as TurnMessage)?.id

    // Only our own turn ending concerns us. The two emitters each deliver a
    // copy, and the previous fighter's end can land after our start — taking
    // that as "the turn changed" aborted the run mid-turn, casting nothing and
    // never passing.
    if (fighterId !== undefined && !isMyTurn(fighterId)) return

    turnPlayable = false
    turnToken += 1
  }

  const onTurnPlaying = () => {
    turnPlayable = true
    missedPlayableAnnouncements = 0
  }

  /**
   * Challenges arrive as ids on the wire; the wording lives in the panel. Both
   * are kept, since the text is what says what a challenge forbids.
   */
  /**
   * The placement phase hands over the cells the character may start on.
   * Standing where an enemy is already in a straight line means the first turn
   * opens with a spell rather than a walk.
   */
  const onPlacementPositions = (...args: unknown[]) => {
    const message = args[0] as { positions?: number[] }
    if (!Array.isArray(message?.positions) || message.positions.length === 0) return
    placementCells = message.positions
  }

  const takePlacementCell = async () => {
    const settings = callbacks.getSettings()
    if (disposed || placed || !settings.enabled || !settings.placeBeforeReady) return
    if (placementCells.length === 0) return

    const choice = choosePlacementCell(gameWindow, placementCells, {
      positioning: settings.positioning
    })
    if (!choice) return

    const current = getMyFighter(gameWindow)?.cellId ?? null
    if (choice.cellId === current) {
      placed = true
      return
    }

    placed = true
    try {
      sendPlacementMove(gameWindow, choice.cellId)
      const why =
        choice.alignedWith.length > 0
          ? `lined up with ${choice.alignedWith.length} enemy(ies)`
          : choice.sees.length > 0
            ? `seeing ${choice.sees.length} enemy(ies)`
            : `${choice.distanceToClosestEnemy} cell(s) from the closest enemy`
      log(`Taking starting cell ${choice.cellId}: ${why}`)
    } catch (err) {
      log(`Could not take a starting cell: ${err instanceof Error ? err.message : String(err)}`)
    }

    await humanSleep(settings.castDelayMs)
  }

  const onChallengeInfo = (...args: unknown[]) => {
    const message = args[0] as { challengeId?: number; targetId?: number }
    if (typeof message?.challengeId !== 'number') return
    if (challenges.some((challenge) => challenge.id === message.challengeId)) return

    challenges = [
      ...challenges,
      {
        id: message.challengeId,
        name: null,
        description: null,
        targetId: typeof message.targetId === 'number' ? message.targetId : null
      }
    ]
  }

  /** Fills the captured challenges with the wording currently on screen. */
  const withChallengeTexts = (): FightChallenge[] => {
    const texts = readChallengeTexts(gameWindow)
    if (texts.length === 0) return challenges
    if (challenges.length === 0) {
      return texts.map((text, index) => ({
        id: -1 - index,
        name: text.name,
        description: text.description,
        targetId: null
      }))
    }
    return challenges.map((challenge, index) => ({
      ...challenge,
      name: challenge.name ?? texts[index]?.name ?? null,
      description: challenge.description ?? texts[index]?.description ?? null
    }))
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
    placementCells = []
    placed = false
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
    challenges = []
    placed = false
    lastCastTurn = new Map()
    // The placement cells arrive with the preparation phase, which can come
    // before this message: clearing them here would throw them away.
    const settings = callbacks.getSettings()
    if (disposed || !settings.enabled || !settings.autoReady) return

    // Take a place first, then press ready. Pressing it the instant the fight
    // opens leaves the client showing "waiting for...", and reads as a machine.
    void (async () => {
      await humanSleep(Math.round(settings.readyDelayMs / 2))
      await takePlacementCell()
      await humanSleep(Math.round(settings.readyDelayMs / 2))
      if (disposed || !callbacks.getSettings().autoReady) return
      try {
        setFightReady(gameWindow, true)
        log('Ready for the fight')
      } catch {}
    })()
  }

  for (const source of [gui, connectionManager]) {
    addListener(source, 'GameFightTurnStartMessage', onTurnStart, cleanups)
    addListener(source, 'GameFightTurnEndMessage', onTurnEnd, cleanups)
    addListener(source, 'GameFightTurnStartPlayingMessage', onTurnPlaying, cleanups)
    addListener(source, 'ChallengeInfoMessage', onChallengeInfo, cleanups)
    addListener(source, 'GameFightPlacementPossiblePositionsMessage', onPlacementPositions, cleanups)
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
