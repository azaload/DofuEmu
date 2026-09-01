import type { DofusWindow } from '@/types/dofus-window'
import {
  getAllies,
  getEnemies,
  getFighters,
  getMyFighter,
  type Fighter
} from '../fight-bridge'
import { readDamageProfile, readResistances, type DamageProfile, type Resistances } from '../damage'
import { readRangeBonus } from '../spell-catalogue'
import { cellDistance, createGrid, type Grid } from './geometry'

/**
 * The fight as the planner sees it: who stands where, what they resist, what
 * they can still reach.
 *
 * Everything is read once, at the top of a plan, and nothing below re-reads
 * the game. A snapshot that shifts under the search is how a cast ends up
 * aimed at a monster that has already moved — and the search asks for the
 * same numbers thousands of times, so reading them once is also what makes it
 * fast enough to run between two casts.
 */

export type Side = 'me' | 'ally' | 'enemy'

export interface Combatant {
  id: number
  name: string
  side: Side
  teamId: number | null
  cellId: number
  life: number
  maxLife: number
  /** Share of life left, 0 to 1. Used to finish the wounded first. */
  health: number
  ap: number
  mp: number
  resistances: Resistances
  /**
   * Cells this fighter can put us in contact from, on its own next turn:
   * its movement points plus the one cell of reach a melee attack has.
   *
   * Monsters do not report their movement points before they have played, so
   * a fight that has not started yet falls back to three — a walking monster,
   * which is what most of them are.
   */
  threatRange: number
  raw: Fighter
}

export interface Battlefield {
  turn: number
  grid: Grid
  me: Combatant
  allies: Combatant[]
  enemies: Combatant[]
  /** Everyone alive, ourselves included. */
  everyone: Combatant[]
  /** Cells every living fighter stands on, ours included. */
  occupied: Set<number>
  /** The character's own damage statistics, read once. */
  profile: DamageProfile
  /** Portée: the range it adds to every boostable spell. */
  rangeBonus: number
}

/** Movement to assume for a monster that has not yet reported any. */
const DEFAULT_MONSTER_MP = 3

function toCombatant(fighter: Fighter, side: Side, fallbackMp: number): Combatant | null {
  if (fighter.cellId === null) return null
  const life = fighter.life ?? 0
  const maxLife = fighter.maxLife ?? life
  const mp = fighter.mp ?? fallbackMp

  return {
    id: fighter.id,
    name: fighter.name ?? `fighter ${fighter.id}`,
    side,
    teamId: fighter.teamId,
    cellId: fighter.cellId,
    life,
    maxLife,
    health: maxLife > 0 ? Math.min(1, Math.max(0, life / maxLife)) : 1,
    ap: fighter.ap ?? 0,
    mp,
    resistances: readResistances(fighter),
    threatRange: Math.max(1, mp) + 1,
    raw: fighter
  }
}

export interface BattlefieldOptions {
  turn: number
  /** Fighters the fight has announced dead, whatever the client still lists. */
  ignore?: ReadonlySet<number>
  /** Reuse a grid across the turn rather than rebuilding its caches. */
  grid?: Grid
}

export function readBattlefield(
  gameWindow: DofusWindow,
  options: BattlefieldOptions
): Battlefield | null {
  const mine = getMyFighter(gameWindow)
  if (!mine || mine.cellId === null) return null

  const gone = options.ignore ?? new Set<number>()
  const me = toCombatant(mine, 'me', 0)
  if (!me) return null

  const enemies = getEnemies(gameWindow)
    .filter((fighter) => !gone.has(fighter.id) && (fighter.life ?? 1) > 0)
    .map((fighter) => toCombatant(fighter, 'enemy', DEFAULT_MONSTER_MP))
    .filter((fighter): fighter is Combatant => fighter !== null)

  const allies = getAllies(gameWindow)
    .filter((fighter) => !gone.has(fighter.id) && (fighter.life ?? 1) > 0)
    .map((fighter) => toCombatant(fighter, 'ally', DEFAULT_MONSTER_MP))
    .filter((fighter): fighter is Combatant => fighter !== null)

  const everyone = [me, ...allies, ...enemies]
  const occupied = new Set<number>(
    getFighters(gameWindow)
      .filter((fighter) => fighter.alive && fighter.cellId !== null && !gone.has(fighter.id))
      .map((fighter) => fighter.cellId as number)
  )
  for (const fighter of everyone) occupied.add(fighter.cellId)

  return {
    turn: options.turn,
    grid: options.grid ?? createGrid(gameWindow),
    me,
    allies,
    enemies,
    everyone,
    occupied,
    profile: readDamageProfile(gameWindow),
    rangeBonus: readRangeBonus(gameWindow)
  }
}

/** Enemies standing next to `cellId` — the ones that tackle a departure. */
export function holdersOf(field: Battlefield, cellId: number): Combatant[] {
  return field.enemies.filter((enemy) => cellDistance(cellId, enemy.cellId) === 1)
}
