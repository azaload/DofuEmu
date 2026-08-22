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
