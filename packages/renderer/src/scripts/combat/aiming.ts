import type { SpellDetails } from '../spell-catalogue'
import type { Combatant } from './battlefield'
import {
  areCellsAligned,
  areaCells,
  areaReach,
  cellCoordinates,
  cellDistance,
  cellsInRing,
  type Grid
} from './geometry'

/**
 * Where a spell is thrown, and what that covers.
 *
 * A cast is aimed at a cell, never at a fighter. That is the whole point: an
 * area spell aimed a cell to the side of a monster often covers two, and a
 * spell with a minimum range cannot be thrown at the monster in contact at
 * all — but the cell behind it still covers it.
 *
 * So every cell the spell may legally be thrown at is considered, and the one
 * that lands on the most monsters wins.
 */

export interface AimCandidate {
  spell: SpellDetails
  /** Cell the cast is thrown from. */
  from: number
  /** Cell the cast is aimed at. */
  cellId: number
  /** Cells the area covers. */
  covered: number[]
  /** Enemies standing in it. */
  enemies: Combatant[]
  /** Allies standing in it, ourselves included. */
  friends: Combatant[]
  /** The caster is in its own area. */
  hitsSelf: boolean
}

export interface AimContext {
  grid: Grid
  /** Range a buff cast earlier in the same turn has already granted. */
  rangeBonus: number
  /** Cells a fighter stands on, as the plan believes them to be. */
  occupied: ReadonlySet<number>
  enemies: Combatant[]
  /** Allies and the character itself: everyone a cast must avoid. */
  friends: Combatant[]
}

/** The range this spell really has, the Portée it takes included. */
export function effectiveRange(spell: SpellDetails, rangeBonus: number): number {
  return spell.range + (spell.rangeBoostable ? rangeBonus : 0)
}

/**
 * Whether the spell may legally be aimed at `cellId` from `from`.
 *
 * Every constraint the game puts on a cast is checked here, and only the ones
 * the client actually described: a field that came back null means "no
 * constraint", never a guess.
 */
export function canAimAt(
  context: AimContext,
  spell: SpellDetails,
  from: number,
  cellId: number
): boolean {
  const distance = cellDistance(from, cellId)
  if (distance > effectiveRange(spell, context.rangeBonus) || distance < spell.minRange) return false

  if (spell.castInLine && !areCellsAligned(from, cellId)) return false
  if (spell.castInDiagonal) {
    const origin = cellCoordinates(from)
    const point = cellCoordinates(cellId)
    if (Math.abs(point.x - origin.x) !== Math.abs(point.y - origin.y)) return false
  }

  const taken = context.occupied.has(cellId)
  if (spell.needsFreeCell && taken) return false
  if (spell.needsTakenCell && !taken) return false

  // An obstacle can still be aimed at by an area spell — the area covers the
  // cells around it — but never by a spell that must land on its target.
  if (!spell.needsTakenCell && !taken && !context.grid.walkable(cellId) && spell.zone.size === 0) {
    return false
  }

  if (spell.needsLineOfSight) {
    // Fighters block sight; the cell aimed at is the exception, since that is
    // where the target itself stands.
    const blockers = new Set(context.occupied)
    blockers.delete(from)
    blockers.delete(cellId)
    if (!context.grid.sees(from, cellId, blockers)) return false
  }

  return true
}

/** Every cell the spell may legally be thrown at from `from`. */
export function legalAimCells(
  context: AimContext,
  spell: SpellDetails,
  from: number
): number[] {
  const range = effectiveRange(spell, context.rangeBonus)
  return cellsInRing(from, spell.minRange, range).filter((cellId) =>
    canAimAt(context, spell, from, cellId)
  )
}

/**
 * The cells worth testing for this spell.
 *
 * Sweeping the whole range band and measuring every cell is how a plan spends
 * longer than the turn it is planning. Only the cells close enough to a
 * fighter for the area to cover it can ever be worth throwing at, and there
 * are a couple of dozen of those — not three hundred.
 */
function candidateCells(
  context: AimContext,
  spell: SpellDetails,
  from: number,
  against: Combatant[]
): number[] {
  const reach = areaReach(spell.zone)

  // "Whole map" areas cover everything wherever they land: the cheapest legal
  // cell is as good as any other.
  if (spell.zone.shape === 'all') {
    return legalAimCells(context, spell, from).slice(0, 1)
  }

  const seen = new Set<number>()
  const cells: number[] = []
  for (const fighter of against) {
    for (const cellId of cellsInRing(fighter.cellId, 0, reach)) {
      if (seen.has(cellId)) continue
      seen.add(cellId)
      if (!canAimAt(context, spell, from, cellId)) continue
      cells.push(cellId)
    }
  }
  return cells
}

/** Who a cast aimed at `cellId` from `from` would actually touch. */
export function coverageOf(
  context: AimContext,
  spell: SpellDetails,
  from: number,
  cellId: number
): AimCandidate {
  const covered = areaCells(spell.zone, from, cellId)
  const inside = new Set(covered)

  const enemies = context.enemies.filter((enemy) => inside.has(enemy.cellId))
  const friends = context.friends.filter((friend) => inside.has(friend.cellId))

  return {
    spell,
    from,
    cellId,
    covered,
    enemies,
    friends,
    hitsSelf: inside.has(from)
  }
}

/**
 * Every worthwhile way of throwing this spell from `from`, most covered
 * fighters first.
 *
 * `against` is who the cast is meant for — the enemies for an attack, the
 * wounded for a heal. Cells that cover none of them are dropped: a cast that
 * touches nobody it was aimed at is not a cast.
 */
export function aimCandidates(
  context: AimContext,
  spell: SpellDetails,
  from: number,
  against: Combatant[],
  limit = 6
): AimCandidate[] {
  if (against.length === 0) return []

  const wanted = new Set(against.map((fighter) => fighter.id))
  const found: AimCandidate[] = []

  for (const cellId of candidateCells(context, spell, from, against)) {
    const candidate = coverageOf(context, spell, from, cellId)
    const covered = [...candidate.enemies, ...candidate.friends].filter((fighter) =>
      wanted.has(fighter.id)
    )
    if (covered.length === 0) continue
    found.push(candidate)
  }

  // The most fighters at once, then the fewest friends caught in it: that is
  // the whole preference order, before any damage is worked out.
  found.sort((a, b) => {
    if (a.enemies.length !== b.enemies.length) return b.enemies.length - a.enemies.length
    if (a.friends.length !== b.friends.length) return a.friends.length - b.friends.length
    return a.cellId - b.cellId
  })

  return found.slice(0, limit)
}

/**
 * The single best cell for a spell that must land on a named target.
 *
 * The manual combo names a monster, not a cell, so the cast still has to be
 * placed: beside a monster in melee for a spell with a minimum range, and on
 * the cell that catches the most of its friends when the area allows.
 */
export function aimAtTarget(
  context: AimContext,
  spell: SpellDetails,
  from: number,
  target: Combatant
): AimCandidate | null {
  const candidates = aimCandidates(context, spell, from, context.enemies, 40)
  let best: AimCandidate | null = null

  for (const candidate of candidates) {
    if (!candidate.enemies.some((enemy) => enemy.id === target.id)) continue
    const score = candidate.enemies.length * 10 - candidate.friends.length * 5
    const bestScore = best ? best.enemies.length * 10 - best.friends.length * 5 : -Infinity
    if (score > bestScore) best = candidate
  }

  return best
}
