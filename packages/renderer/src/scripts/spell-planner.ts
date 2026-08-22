import type { CombatElement } from '@dofemu/shared'
import type { DofusWindow } from '@/types/dofus-window'
import { areCellsAligned, cellDistance, hasLineOfSight, zoneCells } from './cells'
import { getEnemies, getMyFighter, type Fighter } from './fight-bridge'
import { readSpellCatalogue, type SpellDetails } from './spell-catalogue'

/**
 * Chooses what to cast, from the character's own spells.
 *
 * A cast is aimed at a cell, not at a fighter: that is what lets an area spell
 * catch two monsters at once, or reach one it may not target directly. Every
 * candidate is checked against the spell's own numbers — cost, range, minimum
 * range, straight line, line of sight — and scored by what it actually hits.
 */

export interface PlannedCast {
  spellId: number
  name: string | null
  cellId: number
  /** Fighter ids the cast lands on. */
  hits: number[]
  apCost: number
  reason: string
}

export interface SpellPlanOptions {
  /** Elements the character is allowed to use. */
  elements: CombatElement[]
  /** Turns already played, to know what came off cooldown. */
  turn: number
  /** Spell id to the turn it was last cast on. */
  lastCastTurn: Map<number, number>
  /** Casts already made this turn, by spell id. */
  castsThisTurn: Map<number, number>
  /** Action points left. */
  actionPoints: number
}

const BUFF_PRIORITY = 1000

function elementAllowed(spell: SpellDetails, allowed: CombatElement[]): boolean {
  // A spell whose element we cannot read is never filtered out.
  if (spell.elements.length === 0) return true
  return spell.elements.some((element) => allowed.includes(element))
}

function offCooldown(spell: SpellDetails, options: SpellPlanOptions): boolean {
  const last = options.lastCastTurn.get(spell.id)
  if (last === undefined) return true
  const cooldown = spell.cooldown ?? 0
  return options.turn - last > cooldown
}

function castsLeft(spell: SpellDetails, options: SpellPlanOptions): boolean {
  const already = options.castsThisTurn.get(spell.id) ?? 0
  const max = spell.maxCastsPerTurn ?? Number.MAX_SAFE_INTEGER
  return already < max
}

function affordable(spell: SpellDetails, options: SpellPlanOptions): boolean {
  return (spell.apCost ?? 0) <= options.actionPoints
}

export function usableSpells(
  gameWindow: DofusWindow,
  options: SpellPlanOptions
): SpellDetails[] {
  return readSpellCatalogue(gameWindow).filter(
    (spell) =>
      elementAllowed(spell, options.elements) &&
      offCooldown(spell, options) &&
      castsLeft(spell, options) &&
      affordable(spell, options)
  )
}

/** Cells a spell may be aimed at from `from`, given its own constraints. */
export function castableCells(
  gameWindow: DofusWindow,
  spell: SpellDetails,
  from: number
): number[] {
  const cells: number[] = []

  for (let cellId = 0; cellId < 560; cellId++) {
    const distance = cellDistance(from, cellId)
    if (distance > spell.range || distance < spell.minRange) continue
    if (spell.castInLine && !areCellsAligned(from, cellId)) continue
    if (spell.needsLineOfSight && !hasLineOfSight(gameWindow, from, cellId)) continue
    cells.push(cellId)
  }

  return cells
}

/** Fighters an area spell lands on when aimed at `cellId`. */
export function hitsFrom(
  spell: SpellDetails,
  from: number,
  cellId: number,
  fighters: Fighter[]
): Fighter[] {
  const covered = zoneCells(spell.zoneShape, spell.zoneSize, from, cellId)
  return fighters.filter((fighter) => fighter.cellId !== null && covered.includes(fighter.cellId))
}

/**
 * The best cast available right now, or null when nothing is worth it.
 *
 * Buffs come first while they are off cooldown — a boost held up all fight is
 * worth more than one more hit — then the cast that reaches the most enemies,
 * and between equals the one that spends the fewest action points.
 */
export function bestCast(
  gameWindow: DofusWindow,
  options: SpellPlanOptions
): PlannedCast | null {
  const me = getMyFighter(gameWindow)
  if (!me || me.cellId === null) return null

  const from = me.cellId
  const enemies = getEnemies(gameWindow)
  const spells = usableSpells(gameWindow, options)

  let best: (PlannedCast & { score: number }) | null = null

  for (const spell of spells) {
    const apCost = spell.apCost ?? 0

    // A boost or a heal on ourselves: no target to find.
    if (spell.kind === 'boost' || spell.kind === 'heal') {
      const score = BUFF_PRIORITY - apCost
      if (!best || score > best.score) {
        best = {
          spellId: spell.id,
          name: spell.name,
          cellId: from,
          hits: [me.id],
          apCost,
          reason: spell.kind === 'boost' ? 'keeping the boost up' : 'healing',
          score
        }
      }
      continue
    }

    if (spell.kind !== 'damage' || enemies.length === 0) continue

    for (const cellId of castableCells(gameWindow, spell, from)) {
      const hits = hitsFrom(spell, from, cellId, enemies)
      if (hits.length === 0) continue

      // What the cast is worth: everything it touches, per action point.
      const value = hits.length * Math.max(1, spell.damage)
      const score = value * 10 - apCost

      if (!best || score > best.score) {
        best = {
          spellId: spell.id,
          name: spell.name,
          cellId,
          hits: hits.map((fighter) => fighter.id),
          apCost,
          reason:
            hits.length > 1
              ? `${hits.length} enemies in the area`
              : `${hits[0].name ?? hits[0].id}`,
          score
        }
      }
    }
  }

  if (!best) return null
  const { score: _score, ...cast } = best
  return cast
}

/**
 * The whole turn: casts chained until the action points run out or nothing
 * useful is left. The state is advanced between them, so a spell limited to
 * one cast a turn is not chosen twice.
 */
export function planSpellTurn(
  gameWindow: DofusWindow,
  options: SpellPlanOptions,
  maxCasts = 8
): PlannedCast[] {
  const plan: PlannedCast[] = []
  const state: SpellPlanOptions = {
    ...options,
    castsThisTurn: new Map(options.castsThisTurn),
    lastCastTurn: new Map(options.lastCastTurn)
  }

  for (let step = 0; step < maxCasts; step++) {
    const cast = bestCast(gameWindow, state)
    if (!cast) break

    plan.push(cast)
    state.actionPoints -= cast.apCost
    state.castsThisTurn.set(cast.spellId, (state.castsThisTurn.get(cast.spellId) ?? 0) + 1)
    state.lastCastTurn.set(cast.spellId, state.turn)

    if (state.actionPoints <= 0) break
  }

  return plan
}
