import type { CombatElement, CombatPositioning, CombatSpell } from '@dofemu/shared'
import type { DofusWindow } from '@/types/dofus-window'
import type { SpellDetails } from '../spell-catalogue'
import { readSpellCatalogue } from '../spell-catalogue'
import { readBattlefield, type Battlefield } from './battlefield'
import { aimCandidates, type AimContext } from './aiming'
import { elementAllowed } from './spellbook'
import { areCellsAligned, cellDistance, type Grid } from './geometry'

/**
 * Where to start the fight.
 *
 * The preparation phase offers a handful of cells and the whole fight follows
 * from the one taken: a ranged character that starts in the middle of the
 * pack spends turn one being tackled, and one that starts across the map
 * spends it walking.
 *
 * The cell wanted is therefore the furthest one that can still *open* —
 * meaning a spell can be thrown from it, or from somewhere the first turn's
 * movement points reach, at a monster it can see. Distance decides between
 * those; the ones that cannot open are last, however safe they look.
 */

export interface PlacementChoice {
  cellId: number
  /** Enemies this cell can see. */
  sees: number[]
  alignedWith: number[]
  /** Grid distance to the closest monster. -1 when none is placed. */
  distanceToClosestEnemy: number
  /** A spell can be thrown from this very cell, with no walk at all. */
  opensStanding: boolean
  /** One can be thrown after spending some of the first turn's movement. */
  opensAfterMoving: boolean
  /** Movement points that opening cast would cost, 0 when standing still. */
  openingCost: number
  /** Monsters that could reach contact on their own first turn. */
  threats: number
  /** One line saying why this cell, for the activity log. */
  reason: string
}

export interface PlacementOptions {
  positioning: CombatPositioning
  /** Movement points the character will have on its first turn. */
  movementPoints: number
  /** The spells the opening cast may use. */
  weapons: SpellDetails[]
  /** Reuse the battlefield the caller has already read. */
  field?: Battlefield
}

/**
 * A spell the placement can reason about without the client describing one.
 *
 * The manual combo carries a range and nothing else; that is still enough to
 * ask "could I shoot something from here", which is the only question
 * placement needs answered.
 */
export function syntheticSpell(
  id: number,
  range: number,
  minRange = 0,
  kind: 'damage' | 'boost' = 'damage'
): SpellDetails {
  return {
    id,
    name: null,
    level: null,
    apCost: 0,
    detailed: false,
    range,
    minRange,
    rangeBoostable: false,
    castInLine: false,
    castInDiagonal: false,
    needsLineOfSight: true,
    needsFreeCell: false,
    needsTakenCell: false,
    rangeBoost: 0,
    cooldown: 0,
    // Without a price, a spell cannot be chained: one cast a turn is the only
    // safe assumption when the client never described it.
    maxCastsPerTurn: 1,
    maxCastsPerTarget: null,
    zone: { shape: 'point', size: 0, minSize: 0 },
    effects: [],
    damage: kind === 'damage' ? 1 : 0,
    heal: 0,
    kind,
    elements: [],
    pushes: false,
    pushDistance: 0,
    pullDistance: 0,
    apGain: 0,
    mpGain: 0,
    powerBoost: 0,
    buffTurns: 0,
    selfOnly: false,
    isMastery: false
  }
}

/** The character's own attacks, as the placement should read them. */
export function weaponsFromSpellbook(
  gameWindow: DofusWindow,
  elements: CombatElement[]
): SpellDetails[] {
  return readSpellCatalogue(gameWindow).filter(
    (spell) => spell.kind === 'damage' && elementAllowed(spell, elements)
  )
}

/**
 * The same, for a manual combo.
 *
 * A spell the client described is used as it really is — line, area, minimum
 * range and all. One it did not is reduced to the range configured on it,
 * which is all the combo knows about it either.
 */
export function weaponsFromCombo(
  gameWindow: DofusWindow,
  combo: CombatSpell[],
  fallbackRange: number,
  options: { includeSelf?: boolean } = {}
): SpellDetails[] {
  const catalogue = readSpellCatalogue(gameWindow)

  return combo
    .filter((entry) => options.includeSelf === true || !entry.self)
    .map((entry) => {
      const details = catalogue.find((spell) => spell.id === entry.id && spell.detailed)
      if (details && (entry.range === undefined || entry.range < 0)) return details
      const range = typeof entry.range === 'number' && entry.range >= 0 ? entry.range : fallbackRange
      if (details) return { ...details, range: Math.max(details.range, range) }
      // A spell ticked "on me" is cast on our own cell and nowhere else.
      if (entry.self) return syntheticSpell(entry.id, 0, 0, 'boost')
      return syntheticSpell(entry.id, range)
    })
}

function contextFor(field: Battlefield, cellId: number, grid: Grid): AimContext {
  const occupied = new Set(field.occupied)
  occupied.delete(field.me.cellId)
  occupied.add(cellId)

  return {
    grid,
    rangeBonus: 0,
    occupied,
    enemies: field.enemies,
    friends: [{ ...field.me, cellId }]
  }
}

/** Whether any of the weapons can be thrown at a monster from `cellId`. */
function canOpenFrom(field: Battlefield, cellId: number, weapons: SpellDetails[]): boolean {
  const context = contextFor(field, cellId, field.grid)
  return weapons.some((spell) => aimCandidates(context, spell, cellId, field.enemies, 1).length > 0)
}

function describe(
  field: Battlefield,
  cellId: number,
  options: PlacementOptions
): PlacementChoice {
  const sees: number[] = []
  const alignedWith: number[] = []
  let closest = Number.MAX_SAFE_INTEGER
  let threats = 0

  for (const enemy of field.enemies) {
    const distance = cellDistance(cellId, enemy.cellId)
    closest = Math.min(closest, distance)
    if (distance <= enemy.threatRange) threats += 1
    if (!field.grid.sees(cellId, enemy.cellId)) continue
    sees.push(enemy.id)
    if (areCellsAligned(cellId, enemy.cellId)) alignedWith.push(enemy.id)
  }

  const opensStanding = canOpenFrom(field, cellId, options.weapons)

  // The movement points of the first turn are part of the placement: a cell
  // one step out of range is a cell that opens, and it is one step further
  // from the pack than the cell that opens standing still.
  let openingCost = 0
  let opensAfterMoving = opensStanding
  if (!opensStanding && options.movementPoints > 0) {
    const blocked = new Set(field.enemies.map((enemy) => enemy.cellId))
    const reachable = [...field.grid.reachable(cellId, options.movementPoints, blocked).values()]
      .filter((entry) => entry.cellId !== cellId)
      .sort((a, b) => a.cost - b.cost)

    for (const entry of reachable) {
      if (!canOpenFrom(field, entry.cellId, options.weapons)) continue
      opensAfterMoving = true
      openingCost = entry.cost
      break
    }
  }

  return {
    cellId,
    sees,
    alignedWith,
    distanceToClosestEnemy: closest === Number.MAX_SAFE_INTEGER ? -1 : closest,
    opensStanding,
    opensAfterMoving,
    openingCost,
    threats,
    reason: ''
  }
}

function reasonFor(choice: PlacementChoice, positioning: CombatPositioning): string {
  const parts = [`${choice.distanceToClosestEnemy} cell(s) from the closest monster`]

  if (choice.opensStanding) parts.push('shooting from where it stands')
  else if (choice.opensAfterMoving) parts.push(`shooting after ${choice.openingCost} MP`)
  else parts.push('nothing in reach on turn one')

  if (choice.threats === 0) parts.push('out of their first-turn reach')
  else parts.push(`${choice.threats} monster(s) can reach it`)

  if (choice.alignedWith.length > 0) parts.push(`lined up with ${choice.alignedWith.length}`)
  else if (choice.sees.length > 0) parts.push(`seeing ${choice.sees.length}`)

  return `${positioning === 'keep-distance' ? 'as far back as it can still shoot' : 'in reach'}: ${parts.join(', ')}`
}

/**
 * Ranks the offered cells and returns the best of them.
 *
 * Reading the comparator top to bottom is reading the policy: open the fight
 * with a spell, out of the monsters' reach, as far back as both allow.
 */
export function choosePlacement(
  gameWindow: DofusWindow,
  cells: number[],
  options: PlacementOptions
): PlacementChoice | null {
  const field = options.field ?? readBattlefield(gameWindow, { turn: 0 })
  if (!field) return null

  const offered = cells.filter((cellId) => cellId >= 0)
  if (offered.length === 0) return null
  if (field.enemies.length === 0) return null

  const scored = offered.map((cellId) => describe(field, cellId, options))
  const keepDistance = options.positioning !== 'close-in'

  const better = (a: PlacementChoice, b: PlacementChoice): boolean => {
    // A cell the fight cannot be opened from costs a whole turn, whatever else
    // it has going for it.
    if (a.opensAfterMoving !== b.opensAfterMoving) return a.opensAfterMoving

    if (!keepDistance) {
      if (a.distanceToClosestEnemy !== b.distanceToClosestEnemy) {
        return a.distanceToClosestEnemy < b.distanceToClosestEnemy
      }
      if (a.opensStanding !== b.opensStanding) return a.opensStanding
      if (a.sees.length !== b.sees.length) return a.sees.length > b.sees.length
      if (a.alignedWith.length !== b.alignedWith.length) {
        return a.alignedWith.length > b.alignedWith.length
      }
      return a.cellId < b.cellId
    }

    // Out of everyone's first-turn reach is worth more than one more cell of
    // distance: it is the difference between opening the fight tackled and
    // opening it shooting.
    const safe = (choice: PlacementChoice) => choice.threats === 0
    if (safe(a) !== safe(b)) return safe(a)
    if (a.distanceToClosestEnemy !== b.distanceToClosestEnemy) {
      return a.distanceToClosestEnemy > b.distanceToClosestEnemy
    }
    if (a.opensStanding !== b.opensStanding) return a.opensStanding
    if (a.threats !== b.threats) return a.threats < b.threats
    if (a.sees.length !== b.sees.length) return a.sees.length > b.sees.length
    if (a.alignedWith.length !== b.alignedWith.length) return a.alignedWith.length > b.alignedWith.length
    if (a.openingCost !== b.openingCost) return a.openingCost < b.openingCost
    return a.cellId < b.cellId
  }

  const best = scored.reduce((winner, candidate) => (better(candidate, winner) ? candidate : winner))
  return { ...best, reason: reasonFor(best, options.positioning) }
}
