import type { DofusWindow } from '@/types/dofus-window'
import type { Fighter } from './fight-bridge'
import type { SpellDetails } from './spell-catalogue'
import { areaCells } from './zones'
import { canAimAt, effectiveRange } from './combat/aiming'
import { createGrid, cellsInRing } from './combat/geometry'
import { planTurn as planCombatTurn } from './combat/planner'
import type {
  PlanContext,
  PlannedAction,
  PlannedCast,
  PlannedMove,
  PlannedSpell,
  TurnPlan
} from './combat/planner'

/**
 * The turn planner, as the rest of the app has always called it.
 *
 * Everything it does now lives in `combat/`: the map in `geometry`, the fight
 * in `battlefield`, the spells in `spellbook`, the aiming in `aiming`, the
 * scoring in `evaluate` and the search in `planner`. This file is the door
 * they are all reached through, and the two helpers the manual combo still
 * needs to aim a spell by its own rules.
 */

export type { PlanContext, PlannedAction, PlannedCast, PlannedMove, PlannedSpell, TurnPlan }

export const planTurn = planCombatTurn

/**
 * Cells a spell may legally be aimed at, from `from`.
 *
 * Kept for the manual combo, which has no battlefield to hand: it knows a
 * spell, a cell and who is standing where, and that is enough to work out
 * where the cast may go.
 */
export function castableCells(
  gameWindow: DofusWindow,
  spell: SpellDetails,
  from: number,
  occupied: Set<number>,
  /** Range a buff cast earlier in the same turn has already granted. */
  rangeBonus = 0
): number[] {
  const context = {
    grid: createGrid(gameWindow),
    rangeBonus,
    occupied,
    enemies: [],
    friends: []
  }

  return cellsInRing(from, spell.minRange, effectiveRange(spell, rangeBonus)).filter((cellId) =>
    canAimAt(context, spell, from, cellId)
  )
}

/** Fighters an area lands on when the spell is aimed at `cellId` from `from`. */
export function hitsFrom(
  spell: SpellDetails,
  from: number,
  cellId: number,
  fighters: Fighter[]
): Fighter[] {
  const covered = new Set(areaCells(spell.zone, from, cellId))
  return fighters.filter((fighter) => fighter.cellId !== null && covered.has(fighter.cellId))
}
