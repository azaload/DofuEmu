import type { DofusWindow } from '@/types/dofus-window'
import {
  CELL_COUNT,
  areCellsAligned,
  cellCoordinates,
  cellDistance,
  cellFromCoordinates,
  hasLineOfSight,
  isCellWalkable,
  neighbourCells,
  type ReachableCell
} from '../cells'
import { areaCells, type ZoneDescription } from '../zones'

/**
 * The map, answered fast and answered once.
 *
 * Planning a turn asks the same three questions thousands of times — is this
 * cell walkable, does it see that one, how far can I walk — and each of them
 * reaches into the game's own structures. Asking again for every candidate
 * cell is what makes a plan take longer than the turn it plans, so the
 * answers are cached for as long as the fight has not moved.
 *
 * Nothing here knows about fighters or spells: it is the map alone.
 */

export {
  CELL_COUNT,
  areCellsAligned,
  cellCoordinates,
  cellDistance,
  cellFromCoordinates,
  neighbourCells,
  areaCells
}
export type { ReachableCell, ZoneDescription }

/**
 * Cells at a grid distance between `minRange` and `maxRange` of `from`.
 *
 * The alternative is sweeping all 560 cells and measuring each one, which is
 * what every range check used to do. A spell of range 6 touches 84 cells; the
 * sweep looked at 560, for every spell, from every candidate cell.
 */
const ringCache = new Map<string, number[]>()

export function cellsInRing(from: number, minRange: number, maxRange: number): number[] {
  const low = Math.max(0, Math.floor(minRange))
  const high = Math.floor(maxRange)
  if (high < low) return []

  const key = from + ':' + low + ':' + high
  const cached = ringCache.get(key)
  if (cached) return cached

  const centre = cellCoordinates(from)
  const cells: number[] = []

  for (let distance = low; distance <= high; distance++) {
    if (distance === 0) {
      cells.push(from)
      continue
    }
    for (let dx = -distance; dx <= distance; dx++) {
      const dy = distance - Math.abs(dx)
      const first = cellFromCoordinates(centre.x + dx, centre.y + dy)
      if (first !== null) cells.push(first)
      if (dy === 0) continue
      const second = cellFromCoordinates(centre.x + dx, centre.y - dy)
      if (second !== null) cells.push(second)
    }
  }

  // Bounded: a long session walks over many cells, and this must not grow
  // into the reason the client runs out of memory.
  if (ringCache.size > 20000) ringCache.clear()
  ringCache.set(key, cells)
  return cells
}

/**
 * How far from the cell it is aimed at an area still reaches.
 *
 * Used to work out which cells are worth testing for a given spell: only the
 * ones close enough to a monster for the area to cover it. A square reaches
 * its corners, twice its size away in grid distance — over-stating that costs
 * a few cells to test, under-stating it loses the cast.
 */
export function areaReach(zone: ZoneDescription): number {
  if (zone.shape === 'point' || zone.size <= 0) return 0
  if (zone.shape === 'all') return CELL_COUNT

  switch (zone.shape) {
    // Drawn on the grid axes rather than in cell distance, so a corner — or a
    // bar laid across a diagonal cast — is twice its size away.
    case 'square':
    case 'diagonal-cross':
    case 'line':
    case 'perpendicular':
      return zone.size * 2
    default:
      return zone.size
  }
}

export interface Grid {
  /** Cells that can be walked on, as far as the map data lets us tell. */
  walkable(cellId: number): boolean
  /**
   * Whether a spell thrown from one cell can see another.
   *
   * `blockers` are the fighters standing in the way, which block sight as a
   * wall does. Neither end counts: one is the caster, the other the target.
   */
  sees(from: number, to: number, blockers?: ReadonlySet<number>): boolean
  /** Every cell reachable within `budget` steps, with cost and path. */
  reachable(from: number, budget: number, blocked?: ReadonlySet<number>): Map<number, ReachableCell>
  /** Steps to walk from one cell to another, or null when nothing legal leads there. */
  pathTo(from: number, to: number, budget: number, blocked?: ReadonlySet<number>): number[] | null
  /** Cells within a range band, as `cellsInRing` gives them. */
  ring(from: number, minRange: number, maxRange: number): number[]
  /** Forget everything: the map changed, or a wall moved. */
  invalidate(): void
}

function signature(blocked: ReadonlySet<number> | undefined): string {
  if (!blocked || blocked.size === 0) return '-'
  return [...blocked].sort((a, b) => a - b).join(',')
}

export function createGrid(gameWindow: DofusWindow): Grid {
  const walkableCache = new Map<number, boolean>()
  const sightCache = new Map<number, boolean>()
  const lineCache = new Map<number, number[]>()
  const reachCache = new Map<string, Map<number, ReachableCell>>()

  /**
   * Cells the straight line between two cells crosses.
   *
   * Sampling once per step rounds past the cell a wall actually sits on, so
   * the segment is walked four times per step — that is what stopped shots
   * being refused for an obstacle the plan never saw.
   */
  const crossedCells = (from: number, to: number): number[] => {
    const key = from * CELL_COUNT + to
    const cached = lineCache.get(key)
    if (cached) return cached

    const start = cellCoordinates(from)
    const end = cellCoordinates(to)
    const steps = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y))
    const crossed: number[] = []

    if (steps > 1) {
      const substeps = steps * 4
      for (let step = 1; step < substeps; step++) {
        const ratio = step / substeps
        const x = Math.round(start.x + (end.x - start.x) * ratio)
        const y = Math.round(start.y + (end.y - start.y) * ratio)
        const cellId = cellFromCoordinates(x, y)
        if (cellId === null || cellId === from || cellId === to) continue
        if (!crossed.includes(cellId)) crossed.push(cellId)
      }
    }

    lineCache.set(key, crossed)
    return crossed
  }

  const grid: Grid = {
    walkable(cellId: number): boolean {
      const cached = walkableCache.get(cellId)
      if (cached !== undefined) return cached
      const value = isCellWalkable(gameWindow, cellId)
      walkableCache.set(cellId, value)
      return value
    },

    sees(from: number, to: number, blockers?: ReadonlySet<number>): boolean {
      if (from === to) return true

      const key = from * CELL_COUNT + to
      let clear = sightCache.get(key)
      if (clear === undefined) {
        clear = hasLineOfSight(gameWindow, from, to)
        sightCache.set(key, clear)
      }
      if (!clear) return false
      if (!blockers || blockers.size === 0) return true

      for (const cellId of crossedCells(from, to)) {
        if (blockers.has(cellId)) return false
      }
      return true
    },

    reachable(from, budget, blocked) {
      const steps = Math.max(0, Math.floor(budget))
      const key = from + ':' + steps + ':' + signature(blocked)
      const cached = reachCache.get(key)
      if (cached) return cached

      const reached = new Map<number, ReachableCell>()
      reached.set(from, { cellId: from, cost: 0, path: [from] })

      let frontier: ReachableCell[] = [reached.get(from) as ReachableCell]
      for (let step = 1; step <= steps; step++) {
        const next: ReachableCell[] = []
        for (const current of frontier) {
          for (const neighbour of neighbourCells(current.cellId)) {
            if (reached.has(neighbour) || blocked?.has(neighbour)) continue
            if (!grid.walkable(neighbour)) continue
            const entry: ReachableCell = {
              cellId: neighbour,
              cost: step,
              path: [...current.path, neighbour]
            }
            reached.set(neighbour, entry)
            next.push(entry)
          }
        }
        if (next.length === 0) break
        frontier = next
      }

      if (reachCache.size > 400) reachCache.clear()
      reachCache.set(key, reached)
      return reached
    },

    pathTo(from, to, budget, blocked) {
      return grid.reachable(from, budget, blocked).get(to)?.path ?? null
    },

    ring: cellsInRing,

    invalidate() {
      walkableCache.clear()
      sightCache.clear()
      lineCache.clear()
      reachCache.clear()
    }
  }

  return grid
}
