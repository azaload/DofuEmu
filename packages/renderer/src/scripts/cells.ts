import type { DofusWindow } from '@/types/dofus-window'

/**
 * Cell geometry, shared by the roleplay and fight bridges.
 *
 * Dofus lays 560 cells out as 40 interleaved rows of 14. The (x, y) below is
 * the game's own diagonal grid, and the distance between two cells is the
 * Manhattan distance in it.
 */

const MAP_WIDTH = 14
export const CELL_COUNT = 560

type Dict = Record<string, unknown>

function asDict(value: unknown): Dict | null {
  return value && typeof value === 'object' ? (value as Dict) : null
}

export function cellCoordinates(cellId: number): { x: number; y: number } {
  const row = Math.floor(cellId / MAP_WIDTH)
  const col = cellId % MAP_WIDTH
  return { x: col + Math.floor((row + 1) / 2), y: Math.floor(row / 2) - col }
}

export function cellDistance(from: number, to: number): number {
  const a = cellCoordinates(from)
  const b = cellCoordinates(to)
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
}

/** Two cells are aligned when they share a row or a column of the grid. */
export function areCellsAligned(a: number, b: number): boolean {
  const first = cellCoordinates(a)
  const second = cellCoordinates(b)
  return first.x === second.x || first.y === second.y
}

/** Cells that can be walked on, as far as the map data lets us tell. */
export function isCellWalkable(gameWindow: DofusWindow, cellId: number): boolean {
  if (cellId < 0 || cellId >= CELL_COUNT) return false

  const mapRenderer = asDict(asDict(gameWindow.isoEngine)?.mapRenderer)
  if (!mapRenderer) return false

  const isWalkable = mapRenderer.isWalkable
  if (typeof isWalkable === 'function') {
    try {
      return (isWalkable as (id: number) => boolean).call(mapRenderer, cellId) !== false
    } catch {}
  }

  const cells = asDict(mapRenderer.map)?.cells
  const cell = Array.isArray(cells) ? asDict(cells[cellId]) : asDict(asDict(cells)?.[cellId])
  if (!cell) return false

  // `l` carries the cell flags; bit 1 is "movable" on the builds we know.
  const flags = cell.l
  if (typeof flags === 'number') return (flags & 1) !== 0

  return true
}

/**
 * A free cell next to `cellId`, closest to `from` — where to stand to interact
 * with whatever occupies that cell, since walking onto it is impossible.
 */
export function findCellNextTo(
  gameWindow: DofusWindow,
  cellId: number,
  from: number,
  occupied: Set<number> = new Set()
): number | null {
  let best: { cellId: number; cost: number } | null = null

  for (let candidate = 0; candidate < CELL_COUNT; candidate++) {
    if (candidate === cellId || occupied.has(candidate)) continue
    if (cellDistance(candidate, cellId) !== 1) continue
    if (!isCellWalkable(gameWindow, candidate)) continue

    const cost = cellDistance(from, candidate)
    if (!best || cost < best.cost) best = { cellId: candidate, cost }
  }

  return best?.cellId ?? null
}

/** Cell at grid coordinates, or null when they fall outside the map. */
export function cellFromCoordinates(x: number, y: number): number | null {
  const row = x + y
  const col = Math.floor(row / 2) - y
  if (row < 0 || row >= 40 || col < 0 || col >= MAP_WIDTH) return null
  return row * MAP_WIDTH + col
}

/** Dofus direction indices, as the movement message encodes them. */
const STEPS: Array<{ dx: number; dy: number; direction: number }> = [
  { dx: 1, dy: 0, direction: 0 }, // east
  { dx: 0, dy: 1, direction: 2 }, // south
  { dx: -1, dy: 0, direction: 4 }, // west
  { dx: 0, dy: -1, direction: 6 } // north
]

/** The four cells a fighter can step to — fights move orthogonally only. */
export function neighbourCells(cellId: number): number[] {
  const { x, y } = cellCoordinates(cellId)
  return STEPS.map((step) => cellFromCoordinates(x + step.dx, y + step.dy)).filter(
    (cell): cell is number => cell !== null
  )
}

/** Direction index from one cell to an adjacent one, or null if not adjacent. */
export function directionBetween(from: number, to: number): number | null {
  const a = cellCoordinates(from)
  const b = cellCoordinates(to)
  const step = STEPS.find((candidate) => a.x + candidate.dx === b.x && a.y + candidate.dy === b.y)
  return step?.direction ?? null
}

export interface ReachableCell {
  cellId: number
  /** Steps to get there — what the move really costs. */
  cost: number
  /** Cells walked through, starting at the origin and ending on this cell. */
  path: number[]
}

/**
 * Every cell reachable from `from` within `maxSteps`, with the path to it.
 *
 * A breadth-first walk over the cells the character can actually step on:
 * planning on straight-line distance is what got moves rolled back by the
 * server, since it happily picked cells no legal path could reach.
 */
export function reachableCells(
  gameWindow: DofusWindow,
  from: number,
  maxSteps: number,
  blocked: Set<number> = new Set()
): Map<number, ReachableCell> {
  const reached = new Map<number, ReachableCell>()
  reached.set(from, { cellId: from, cost: 0, path: [from] })
  if (maxSteps <= 0) return reached

  let frontier: ReachableCell[] = [reached.get(from) as ReachableCell]

  for (let step = 1; step <= maxSteps; step++) {
    const next: ReachableCell[] = []

    for (const current of frontier) {
      for (const neighbour of neighbourCells(current.cellId)) {
        if (reached.has(neighbour) || blocked.has(neighbour)) continue
        if (!isCellWalkable(gameWindow, neighbour)) continue

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

  return reached
}

/**
 * Whether a spell thrown from `from` can see `to`.
 *
 * Walks the straight line between the two cells and stops at the first one the
 * map marks as blocking sight. The game's own check is used when the build
 * exposes one, since it also knows about fighters standing in the way.
 */
export function hasLineOfSight(
  gameWindow: DofusWindow,
  from: number,
  to: number,
  blockers: Set<number> = new Set()
): boolean {
  if (from === to) return true

  const mapRenderer = asDict(asDict(gameWindow.isoEngine)?.mapRenderer)
  for (const method of ['isInLineOfSight', 'lineOfSight', 'losBetween']) {
    const fn = mapRenderer?.[method]
    if (typeof fn === 'function') {
      try {
        return (fn as (a: number, b: number) => boolean).call(mapRenderer, from, to) !== false
      } catch {}
    }
  }

  const start = cellCoordinates(from)
  const end = cellCoordinates(to)
  const steps = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y))
  if (steps <= 1) return true

  const cells = asDict(asDict(mapRenderer?.map)?.cells)
  const blocksSight = (cellId: number): boolean => {
    const cell = Array.isArray(cells) ? asDict(cells[cellId]) : asDict(cells?.[cellId])
    const flags = cell?.l
    // Bit 2 of the cell flags carries "sight passes through".
    if (typeof flags === 'number') return (flags & 2) === 0
    return false
  }

  for (let step = 1; step < steps; step++) {
    const ratio = step / steps
    const x = Math.round(start.x + (end.x - start.x) * ratio)
    const y = Math.round(start.y + (end.y - start.y) * ratio)
    const cellId = cellFromCoordinates(x, y)
    if (cellId === null) continue
    if (cellId === from || cellId === to) continue
    // A fighter standing in the way blocks sight just as a wall does.
    if (blockers.has(cellId)) return false
    if (blocksSight(cellId)) return false
  }

  return true
}

/**
 * Cells an area of effect covers.
 *
 * Dofus describes a zone by a shape letter and a size: a point, a circle, a
 * cross, a line, and a few rarer ones. The shapes below are the ones that
 * change how a spell is aimed; anything unknown falls back to a circle, which
 * over-estimates rather than misses.
 */
export function zoneCells(
  shape: number | string | null,
  size: number | null,
  from: number,
  target: number
): number[] {
  const radius = Math.max(0, size ?? 0)
  if (radius === 0) return [target]

  const letter =
    typeof shape === 'number' ? String.fromCharCode(shape).toUpperCase() : (shape ?? 'C').toUpperCase()

  const centre = cellCoordinates(target)
  const hit: number[] = []

  const push = (x: number, y: number) => {
    const cellId = cellFromCoordinates(x, y)
    if (cellId !== null && !hit.includes(cellId)) hit.push(cellId)
  }

  switch (letter) {
    case 'P': // a single cell
      return [target]

    case 'X': // cross: the two grid axes through the target
      push(centre.x, centre.y)
      for (let step = 1; step <= radius; step++) {
        push(centre.x + step, centre.y)
        push(centre.x - step, centre.y)
        push(centre.x, centre.y + step)
        push(centre.x, centre.y - step)
      }
      return hit

    case 'L': // line: carries on away from the caster
    case 'T': {
      const origin = cellCoordinates(from)
      const dx = Math.sign(centre.x - origin.x)
      const dy = Math.sign(centre.y - origin.y)
      push(centre.x, centre.y)
      for (let step = 1; step <= radius; step++) {
        push(centre.x + dx * step, centre.y + dy * step)
      }
      return hit
    }

    default: {
      // Circle, and anything we do not know: every cell within the radius.
      for (let x = centre.x - radius; x <= centre.x + radius; x++) {
        for (let y = centre.y - radius; y <= centre.y + radius; y++) {
          if (Math.abs(x - centre.x) + Math.abs(y - centre.y) > radius) continue
          push(x, y)
        }
      }
      return hit
    }
  }
}
