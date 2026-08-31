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
  setFightReady,
  readPlacementCells,
  getAllies,
  type Fighter
} from '@/scripts/fight-bridge'
import { requestMoveToCell } from '@/scripts/game-bridge'
import { reachableCells } from '@/scripts/cells'
import { planTurn as planSpellTurn, castableCells, hitsFrom } from '@/scripts/spell-planner'
import { readRangeBonus, readSpellCatalogue, type SpellDetails } from '@/scripts/spell-catalogue'
import { findCharacterSheet, readDamageProfile } from '@/scripts/damage'
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
const DUPLICATE_FIGHT_MS = 3000
const CAST_CONFIRM_MS = 1500
const PLACEMENT_WAIT_MS = 2500
const PLACEMENT_MOVE_MS = 1200
// Every wait costs up to one poll, and a turn waits several times: a short
// period is what keeps a fight from crawling.
const IDLE_POLL_MS = 20

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
  /** Both emitters announce a fight start; the second one is an echo. */
  let lastFightStartAt = 0
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
  /** Spell ids the server confirmed casting since the last request. */
  let castsConfirmed = 0
  /** `spellId:cellId` the server refused this turn: never asked for twice. */
  let refusedCasts = new Set<string>()
  /** Fighters the fight has announced dead, ahead of the client's own list. */
  let deadFighters = new Set<number>()
  /**
   * Spells whose price rises with each cast in a turn, and by how much.
   *
   * Learnt from a refusal once, then applied for the rest of the fight: the
   * second cast of such a spell is planned at its real price instead of being
   * refused again every single turn.
   */
  let escalating = new Map<number, number>()
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

    // The spellbook, not the raw level: a boostable spell reaches as far as
    // the character's Portée takes it, and reading the printed number alone
    // makes the combo skip targets it could hit.
    const details = readSpellCatalogue(gameWindow).find(
      (entry) => entry.id === spell.id && entry.detailed
    )
    if (details) return { range: details.range, source: 'the spellbook' }

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

    // A spell that must be thrown along an axis is worthless from a cell that
    // is not on one, whatever the setting says: the combo decides this, not a
    // preference.
    const catalogue = readSpellCatalogue(gameWindow)
    const needsLine = combo.some(
      (entry) => catalogue.find((spell) => spell.id === entry.id && spell.detailed)?.castInLine
    )

    const move = findPositionCell(gameWindow, target, range, movementPoints, {
      preferLineUp: settings.preferLineUp || needsLine,
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

    // What the move actually does, not what the setting asks for: a log that
    // says "keeping my distance" while walking towards the pack is worse than
    // no log at all.
    const name = target.name ?? `fighter ${target.id}`
    const intent =
      move.distanceToTarget < distance
        ? `closing on ${name}, ${distance} to ${move.distanceToTarget} cell(s)`
        : move.distanceToTarget > distance
          ? `backing off ${name}, ${distance} to ${move.distanceToTarget} cell(s)`
          : `sidestepping, still ${move.distanceToTarget} cell(s) from ${name}`
    const escaping = tacklers.length > 0 ? `, breaking away from ${tacklers.length} monster(s)` : ''
    log(
      `Moving to cell ${move.cellId}: ${move.cost} of ${movementPoints} MP, ${intent}${escaping}` +
        (move.aligned ? ', lined up' : '') +
        (move.inRange ? ', in range' : `, out of range ${range} from ${source}`)
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
    // The same combo entry can come round twice, once per target: saying the
    // same thing twice hides how much of the turn was actually played.
    const said = new Set<string>()
    const sayOnce = (message: string) => {
      if (said.has(message)) return
      said.add(message)
      log(message)
    }

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

      const allowed = reachable

      const targets =
        settings.spreadCasts && allowed.length > 1
          ? allowed
          : [allowed[0] ?? pickTarget(gameWindow, settings.targetStrategy)].filter(
              (fighter): fighter is NonNullable<typeof fighter> => !!fighter
            )

      if (targets.length === 0) {
        // Nothing for this spell is not nothing for the combo: the next entry
        // may reach further, or hit an enemy this one cannot.
        if (getEnemies(gameWindow).length === 0) {
          log('No enemy left, stopping the combo')
          break
        }
        sayOnce(`Skipping ${spell.name || spell.id}: nothing within ${range} cell(s)`)
        continue
      }

      for (const chosen of targets) {
        if (!stillOurTurn() || !isFightStarted(gameWindow)) return

        // The list was drawn before the first cast of this entry: a monster
        // killed since is gone, and one pushed since has moved. Both are read
        // again here rather than aimed at where they used to be.
        const target = getEnemies(gameWindow).find((enemy) => enemy.id === chosen.id)
        if (!target || target.cellId === null) {
          sayOnce(`${chosen.name ?? chosen.id} is down: moving on to the next target`)
          continue
        }

        // The combo is a fixed list, so it can name a target the spell cannot
        // possibly reach. Casting anyway wastes the turn and reads as a bug.
        const here = getMyFighter(gameWindow)?.cellId ?? null
        if (here !== null) {
          const distance = cellDistance(here, target.cellId)
          if (distance > range) {
            sayOnce(
              `Skipping ${spell.name || spell.id}: ${target.name ?? target.id} is ${distance} cell(s) away, range ${range}`
            )
            continue
          }
        }

        // Aim through the spell's own rules — minimum range, line, area — so a
        // monster in melee is caught by a cast placed beside it rather than
        // skipped, and an area lands on as many enemies as it can reach.
        const mine = getMyFighter(gameWindow)
        // Only a spell the client really described is aimed by its own rules;
        // otherwise the configured range is all there is to go on.
        const details = readSpellCatalogue(gameWindow).find(
          (entry) => entry.id === spell.id && entry.detailed
        )
        const aim =
          details && mine
            ? aimFor(details, target, getEnemies(gameWindow), [mine, ...getAllies(gameWindow)], range)
            : null
        const cellId = aim?.cellId ?? target.cellId

        if (details && !aim) {
          // The number that matters is where the target stands against what
          // the spell can reach, and what ruled the cells out.
          const gap = mine?.cellId != null ? cellDistance(mine.cellId, target.cellId) : null
          sayOnce(
            `Skipping ${spell.name || spell.id}: ${target.name ?? target.id}` +
              (gap === null ? '' : ` is ${gap} cell(s) away`) +
              `, reach ${details.minRange}-${Math.max(details.range, range)}` +
              (details.castInLine ? ', straight line only' : '') +
              (details.needsLineOfSight ? ', needs a clear line' : '')
          )
          continue
        }

        const confirmedBefore = castsConfirmed
        try {
          castSpell(gameWindow, spell.id, cellId)
        } catch (err) {
          log(`Cast failed: ${err instanceof Error ? err.message : String(err)}`)
          break
        }

        if (!(await waitFor(() => castsConfirmed > confirmedBefore, CAST_CONFIRM_MS))) {
          log(`The game refused ${spell.name || spell.id} on cell ${cellId} (sight or a state)`)
          continue
        }

        const caster = getMyFighter(gameWindow)
        const distance =
          caster?.cellId !== null && caster?.cellId !== undefined
            ? cellDistance(caster.cellId, cellId)
            : null
        log(
          `Cast ${spell.name || spell.id} on ${target.name ?? target.id}` +
            (aim && aim.hits.length > 1 ? ` and ${aim.hits.length - 1} more in the area` : '') +
            (distance !== null ? ` from ${distance} cell(s)` : '')
        )

        await humanSleep(settings.castDelayMs)
        // Let the spell animation play out before the next action.
        await waitForIdle()
      }
    }
  }

  /**
   * Where to aim a combo spell so it lands on the most enemies.
   *
   * A fixed combo names a target, not a cell, and a spell is rarely aimed at
   * the target itself: one with a minimum range cannot be thrown at a monster
   * in melee at all, and an area spell aimed a cell to the side often covers
   * two. The cell is therefore chosen the way the planner chooses it — every
   * cell the spell may legally be thrown at, scored by what its area covers.
   */
  const aimFor = (
    spell: SpellDetails,
    target: Fighter,
    enemies: Fighter[],
    friends: Fighter[],
    /** Range configured for this combo entry, when the client's is unusable. */
    effectiveRange: number
  ): { cellId: number; hits: Fighter[]; legal: number } | null => {
    const here = getMyFighter(gameWindow)?.cellId ?? null
    if (here === null || target.cellId === null) return null

    const occupied = new Set(
      [...enemies, ...friends]
        .map((fighter) => fighter.cellId)
        .filter((cellId): cellId is number => cellId !== null)
    )

    const reach = { ...spell, range: Math.max(spell.range, effectiveRange) }

    const legal = castableCells(gameWindow, reach, here, occupied)
    let best: { cellId: number; hits: Fighter[]; score: number } | null = null
    for (const cellId of legal) {
      const hits = hitsFrom(reach, here, cellId, enemies)
      // The combo names a target: a cell that catches somebody else instead is
      // not the same cast, however many it touches.
      if (!hits.some((enemy) => enemy.id === target.id)) continue

      const friendlyHits = hitsFrom(reach, here, cellId, friends).length
      const score = hits.length * 10 - friendlyHits * 5
      if (!best || score > best.score) best = { cellId, hits, score }
    }

    return best ? { cellId: best.cellId, hits: best.hits, legal: legal.length } : null
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
    let cast = 0
    let reported = false
    let spentAp = 0
    let movementRefused = false
    refusedCasts = new Set()
    const castsPerSpell = new Map<number, number>()

    // What each spell really costs right now: the book's price, plus what a
    // spell known to grow with use has added since the turn began.
    const pricesNow = () => {
      const prices = new Map<number, number>()
      if (escalating.size === 0) return prices
      for (const spell of readSpellCatalogue(gameWindow)) {
        const step = escalating.get(spell.id)
        if (!step) continue
        prices.set(spell.id, (spell.apCost ?? 0) + step * (castsPerSpell.get(spell.id) ?? 0))
      }
      return prices
    }
    const startingAp = getMyFighter(gameWindow)?.ap ?? 0

    // The plan is redone after every action, from the points the game really
    // reports — but never above what this turn started with minus what we have
    // already spent. A client that does not decrement its own counter would
    // otherwise have us cast until the server refuses everything.
    for (let step = 0; step < 12; step++) {
      if (!stillOurTurn() || !isFightStarted(gameWindow)) break

      const me = getMyFighter(gameWindow)
      if (!me || me.cellId === null) break

      const apCosts = pricesNow()
      const budget = Math.max(0, startingAp - spentAp)
      const actionPoints = Math.min(me.ap ?? 0, budget)
      const movementPoints = movementRefused ? 0 : (me.mp ?? 0)
      if (actionPoints <= 0 && movementPoints <= 0) break

      const held = settings.tackleAware && tacklingEnemies(getEnemies(gameWindow), me.cellId).length > 0

      const plan = planSpellTurn(gameWindow, {
        turn,
        actionPoints,
        movementPoints,
        elements: settings.elements ?? [],
        lastCastTurn,
        canMove: settings.approachEnemies && !held,
        keepDistance: settings.positioning === 'keep-distance',
        blockedCasts: refusedCasts,
        ignoreFighters: deadFighters,
        apCosts,
        castsThisTurn: castsPerSpell
      })

      if (!plan) {
        log('The fight state could not be read: falling back to the combo')
        break
      }

      const action = plan.actions[0]
      if (!action) {
        // Never a silent nothing: the reason is what makes this fixable.
        if (!reported && plan.diagnostic && cast === 0) log(`No plan — ${plan.diagnostic}`)
        // Points left over with spells unused is the case worth explaining:
        // an element left unticked or a range missed by one costs a whole turn
        // and looks, from the log alone, exactly like a good turn.
        if (!reported && actionPoints > 0 && plan.leftOut.length > 0) {
          log(`${actionPoints} AP left — ${plan.leftOut.slice(0, 4).join('; ')}`)
        }
        reported = true
        break
      }

      if (action.type === 'move') {
        log(`Moving to cell ${action.cellId} (${action.cost} MP) ${action.reason}`)
        if (!sendFightMove(gameWindow, action.path)) break

        const outcome = await waitForMove(action.cellId)
        await waitForIdle()
        if (outcome === 'no-move') {
          // Refusing a walk is no reason to give up the turn: the points that
          // are left still buy spells from where the character stands.
          log('The move was refused, casting from here')
          movementRefused = true
          continue
        }
        await humanSleep(0)
        continue
      }

      const confirmedBefore = castsConfirmed
      try {
        castSpell(gameWindow, action.spellId, action.cellId)
      } catch (err) {
        log(`Cast failed: ${err instanceof Error ? err.message : String(err)}`)
        break
      }

      // A refused cast — an obstacle in the way, a state the spell forbids —
      // comes back as silence. Waiting for the confirmation is what tells the
      // two apart, and what stops a refusal from holding the turn until the
      // clock runs out.
      const confirmed = await waitFor(() => castsConfirmed > confirmedBefore, CAST_CONFIRM_MS)
      if (!confirmed) {
        // A spell that grows with use is refused for want of a point, not for
        // want of a line: raising its price and trying again is what plays it
        // to the end of the turn instead of dropping it after the first cast.
        const priced = apCosts.get(action.spellId) ?? action.apCost
        const already = castsPerSpell.get(action.spellId) ?? 0
        if (already > 0 && priced < actionPoints && !escalating.has(action.spellId)) {
          // It worked once and is refused now with points to spare: this is a
          // spell that costs a point more on every cast. Remembered for the
          // rest of the fight, not just the rest of the turn.
          escalating.set(action.spellId, 1)
          log(
            `${action.name || action.spellId} was refused at ${priced} AP: it grows with use, ` +
              `pricing it at ${priced + 1} AP from now on`
          )
          continue
        }

        refusedCasts.add(`${action.spellId}:${action.cellId}`)
        log(
          `The game refused ${action.name || action.spellId} on cell ${action.cellId}` +
            ' (sight or a state): planning something else'
        )
        continue
      }

      lastCastTurn.set(action.spellId, turn)
      cast += 1
      castsPerSpell.set(action.spellId, (castsPerSpell.get(action.spellId) ?? 0) + 1)
      spentAp += apCosts.get(action.spellId) ?? action.apCost
      log(
        `Cast ${action.name || action.spellId} on cell ${action.cellId}: ${action.reason}` +
          (action.apCost > 0 ? ` (${action.apCost} AP)` : '')
      )

      await humanSleep(settings.castDelayMs)
      // The push and pull of a cast move monsters. Letting the animation finish
      // before planning again is what keeps a second area spell from being
      // thrown at cells its own first cast has just emptied.
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

    // An empty combo is normal in automatic mode: the spellbook is what decides
    // there. Only the manual mode has nothing to play without one.
    if (combo.length === 0 && settings.spellMode !== 'auto') {
      log(`Turn ${turn}: ${label} is empty, passing`)
      return
    }

    log(
      settings.spellMode === 'auto'
        ? `Turn ${turn}: planning from the spellbook`
        : `Turn ${turn}: manual mode, playing the ${label}`
    )
    await humanSleep(settings.turnStartDelayMs)

    // Challenges are reported, never enforced: holding one is not worth losing
    // a fight or dragging it out.
    const rules = deriveChallengeRules(withChallengeTexts())

    if (settings.brain === 'ollama') {
      const outcome = await playWithModel(settings, combo, turn, stillOurTurn)

      // A small model plays one or two actions and stops, leaving most of the
      // turn unspent. Whatever it managed, the rest of the turn is played on
      // the rules — points left at the end of a turn are points thrown away.
      if (outcome === 'played' || outcome === 'no-cast') {
        if (outcome === 'no-cast') log('The model only moved: casting on top')
        const left = getMyFighter(gameWindow)
        const points = left?.ap ?? 0
        if (points > 0 && stillOurTurn() && isFightStarted(gameWindow)) {
          log(`Model left ${points} AP: finishing the turn on the rules`)
          await castForTurn(settings, combo, label, turn, rules, stillOurTurn)
        }
        return
      }
    }

    await breakMeleeWithPush(settings, combo)
    if (!stillOurTurn() || !isFightStarted(gameWindow)) return

    if (settings.spellMode !== 'auto') await positionForTurn(settings, combo)
    if (!stillOurTurn() || !isFightStarted(gameWindow)) return

    await castForTurn(settings, combo, label, turn, rules, stillOurTurn)

    if (!stillOurTurn()) return
    if (settings.endTurnAfterCombo) {
      // Ending the turn mid-sequence leaves the client waiting forever.
      await waitForIdle()
      passTurn()
    }
    }
  }

  /**
   * Casts the turn, automatic mode first.
   *
   * The combo is only a fallback there, and saying which one ran matters: a
   * log that always announces the combo hides the fact that the spellbook
   * planner found nothing and why.
   */
  const castForTurn = async (
    settings: CombatSettings,
    combo: CombatSpell[],
    label: string,
    turn: number,
    rules: ReturnType<typeof deriveChallengeRules>,
    stillOurTurn: () => boolean
  ): Promise<void> => {
    if (settings.spellMode !== 'auto') {
      await castCombo(settings, combo, rules, stillOurTurn)
      return
    }

    const cast = await castFromSpellbook(settings, turn, rules, stillOurTurn)
    if (cast > 0 || combo.length === 0) return

    log(`Falling back to the ${label}`)
    await castCombo(settings, combo, rules, stillOurTurn)
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

    // The offered cells and the monsters both arrive with the preparation
    // phase, in no fixed order. Choosing before either is known scores every
    // cell the same and takes the first one — which is what "the placement
    // does nothing" looks like from the outside.
    // The message is the usual source; a build that names it differently, or a
    // mod that loaded after it went past, still finds the cells on the client.
    let offer = { cells: placementCells, source: 'the preparation message', hints: [] as string[] }
    const known = await waitFor(() => {
      if (placementCells.length > 0) {
        offer = { cells: placementCells, source: 'the preparation message', hints: [] }
      } else {
        const read = readPlacementCells(gameWindow)
        if (read.cells.length > 0) offer = read
      }
      return offer.cells.length > 0 && getEnemies(gameWindow).some((enemy) => enemy.cellId !== null)
    }, PLACEMENT_WAIT_MS)

    if (!known) {
      const read = readPlacementCells(gameWindow)
      log(
        offer.cells.length === 0
          ? `Placement: no starting cell found${read.hints.length > 0 ? ` (client exposes ${read.hints.join(', ')})` : ''}`
          : 'Placement: no monster is placed yet, keeping the starting cell'
      )
      return
    }

    const choice = choosePlacementCell(gameWindow, offer.cells, {
      positioning: settings.positioning
    })
    if (!choice) {
      log('Placement: none of the offered cells could be scored')
      return
    }

    const current = getMyFighter(gameWindow)?.cellId ?? null
    if (choice.cellId === current) {
      placed = true
      log(`Placement: already on the best of ${offer.cells.length} starting cell(s) from ${offer.source}`)
      return
    }

    placed = true
    try {
      sendPlacementMove(gameWindow, choice.cellId)
      const why =
        `${choice.distanceToClosestEnemy} cell(s) from the closest monster` +
        (choice.alignedWith.length > 0
          ? `, lined up with ${choice.alignedWith.length}`
          : choice.sees.length > 0
            ? `, seeing ${choice.sees.length}`
            : '')
      log(
        `Taking starting cell ${choice.cellId} of ${offer.cells.length} from ${offer.source}: ${why}`
      )

      // The server can refuse the cell — someone else took it first.
      const moved = await waitFor(
        () => getMyFighter(gameWindow)?.cellId === choice.cellId,
        PLACEMENT_MOVE_MS
      )
      if (!moved) log(`Placement: the game kept me on cell ${current}`)
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

  /**
   * The server accepted a cast.
   *
   * A refusal — an obstacle in the way, a state the spell forbids — is silent
   * on the wire: nothing comes back at all. Counting what is confirmed is
   * therefore the only way to notice, and noticing is what keeps a refused
   * cast from holding the turn until the clock runs out.
   */
  const onSpellCast = () => {
    castsConfirmed += 1
  }

  /**
   * A fighter died.
   *
   * The client keeps a corpse in its list until the death has played out, so
   * a plan made in between aims a spell at a monster that is already gone —
   * and lands it on whatever else the area happens to cover.
   */
  const onFighterDeath = (...args: unknown[]) => {
    const message = args[0] as { targetId?: number; id?: number }
    const id = typeof message?.targetId === 'number' ? message.targetId : message?.id
    if (typeof id === 'number') deadFighters.add(id)
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

  /**
   * One line at the start of a fight saying what is about to play.
   *
   * The manual combo casts exactly what the settings list and nothing else —
   * no ranges, no areas, no damage comparison — so a log that does not say
   * which mode is running turns every question about a fight into a guess.
   */
  const describeSetup = (settings: CombatSettings) => {
    const manual = settings.spellMode !== 'auto'

    try {
      const catalogue = readSpellCatalogue(gameWindow)
      const usable = catalogue.filter(
        (spell) => spell.kind === 'damage' || spell.kind === 'heal' || spell.kind === 'boost'
      )

      // The manual combo needs the range and the Portée as much as the planner
      // does — it is what decides whether a monster counts as reachable — so
      // both modes report what they are working from.
      log(
        manual
          ? 'Fight: manual combo mode — the spellbook planner is off ' +
            '(set Spells to "AI chooses" for areas, damage and sequencing)'
          : `Fight: automatic mode, ${settings.brain} brain, ` +
            `${catalogue.length} spell(s) read, ${usable.length} usable`
      )

      // Portée against the spells that take it: the two together are what a
      // "range 5" in a skip message really means.
      const boosted = catalogue.filter((spell) => spell.rangeBoostable).length
      log(
        `Portée +${readRangeBonus(gameWindow)}, added to ${boosted} of ${catalogue.length} spell(s)`
      )

      // Which characteristic feeds which element decides every choice below.
      // All zeroes means the sheet was not found, and every spell then looks
      // equally good — the fire one as much as the earth one.
      const profile = readDamageProfile(gameWindow)
      const sheet = findCharacterSheet(gameWindow)
      log(
        `Stats: earth ${profile.stat.earth}, fire ${profile.stat.fire}, water ${profile.stat.water}, ` +
          `air ${profile.stat.air}, +${profile.damagePercent}% damage (from ${sheet.path})`
      )
      if (!sheet.stats) {
        log(
          'Stats: the character sheet was not found — every element scores the same, ' +
            'so the hardest hitter is picked on printed dice alone'
        )
      }

      // The areas as this build describes them, to be read against the spell
      // sheets in game: a shape this code does not know falls back to a circle
      // and is named here rather than quietly approximated.
      const areas = usable.filter((spell) => spell.zone.size > 0)
      if (areas.length > 0) {
        log(
          'Areas: ' +
            areas
              .map((spell) => `${spell.name ?? spell.id} ${spell.zone.shape}/${spell.zone.size}`)
              .join(', ')
        )
      }

      // An element left unticked silently removes every spell that uses it.
      const ticked = manual ? [] : (settings.elements ?? [])
      if (ticked.length > 0) {
        const disabled = usable.filter(
          (spell) =>
            spell.kind === 'damage' &&
            spell.elements.length > 0 &&
            !spell.elements.some((element) => ticked.includes(element))
        )
        log(
          `Elements ticked: ${ticked.join(', ')}` +
            (disabled.length > 0
              ? ` — ${disabled.length} spell(s) disabled by that filter: ${disabled
                  .map((spell) => spell.name ?? spell.id)
                  .join(', ')}`
              : '')
        )
      }
    } catch (err) {
      log(
        `Fight: automatic mode, spellbook unreadable (${err instanceof Error ? err.message : String(err)})`
      )
    }
  }

  const onFightStart = () => {
    // Both emitters deliver this message; acting twice presses ready twice.
    const now = Date.now()
    if (now - lastFightStartAt < DUPLICATE_FIGHT_MS) return
    lastFightStartAt = now

    myTurn = 0
    lastTurnOwner = null
    turnPlayable = false
    sequenceDepth = 0
    turnToken += 1
    challenges = []
    placed = false
    deadFighters = new Set()
    escalating = new Map()
    lastCastTurn = new Map()
    // The placement cells arrive with the preparation phase, which can come
    // before this message: clearing them here would throw them away.
    const settings = callbacks.getSettings()
    if (disposed || !settings.enabled) return

    describeSetup(settings)
    if (!settings.autoReady) return

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
    addListener(source, 'GameActionFightSpellCastMessage', onSpellCast, cleanups)
    addListener(source, 'GameActionFightDeathMessage', onFighterDeath, cleanups)
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
