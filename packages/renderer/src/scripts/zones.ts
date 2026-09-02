import { cellCoordinates, cellFromCoordinates, CELL_COUNT } from './cells'

/**
 * The cells a spell's area covers.
 *
 * Dofus describes an area by a shape letter, a size, and sometimes a minimum
 * size that hollows it out — a circle of 3 with a minimum of 1 is a ring. The
 * shapes below are the ones that change where a spell is worth aiming.
 *
 * A letter we do not know falls back to a circle and is reported, so an
 * unusual spell is visibly approximated rather than silently mishandled.
 */

export type ZoneShape =
  | 'point'
  | 'circle'
  | 'square'
  | 'line'
  | 'perpendicular'
  | 'cross'
  | 'diagonal-cross'
  | 'ring'
  | 'all'
  | 'unknown'

/** Shape letters as the protocol sends them. */
const SHAPES: Record<string, ZoneShape> = {
  P: 'point',
  C: 'circle',
  G: 'square',
  L: 'line',
  I: 'line',
  T: 'perpendicular',
  X: 'diagonal-cross',
  '+': 'cross',
  O: 'ring',
  A: 'all',
  D: 'cross'
}

export function zoneShapeOf(raw: number | string | null | undefined): ZoneShape {
  if (raw === null || raw === undefined) return 'point'
  const letter = typeof raw === 'number' ? String.fromCharCode(raw) : String(raw)
  return SHAPES[letter.toUpperCase()] ?? 'unknown'
}

export interface ZoneDescription {
  shape: ZoneShape
  size: number
  /** Cells closer than this are left out, which hollows the area. */
  minSize: number
}

function push(cells: number[], x: number, y: number) {
  const cellId = cellFromCoordinates(x, y)
  if (cellId !== null && !cells.includes(cellId)) cells.push(cellId)
}

/** Grid distance in the same coordinates the shapes are drawn in. */
function gridDistance(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by)
}

/**
 * Cells covered when `target` is aimed at from `from`.
 *
 * `from` matters for the shapes that follow the cast direction — a line goes
 * away from the caster, a perpendicular bar lies across it.
 */
export function areaCells(zone: ZoneDescription, from: number, target: number): number[] {
  const { shape, size, minSize } = zone
  if (shape === 'point' || size <= 0) return [target]

  const centre = cellCoordinates(target)
  const origin = cellCoordinates(from)
  const cells: number[] = []

  const withinRing = (x: number, y: number) =>
    gridDistance(x, y, centre.x, centre.y) >= minSize

  switch (shape) {
    case 'all': {
      for (let cellId = 0; cellId < CELL_COUNT; cellId++) cells.push(cellId)
      return cells
    }

    case 'square': {
      // A square in grid coordinates: everything within `size` on both axes.
      for (let x = centre.x - size; x <= centre.x + size; x++) {
        for (let y = centre.y - size; y <= centre.y + size; y++) {
          if (!withinRing(x, y)) continue
          push(cells, x, y)
        }
      }
      return cells
    }

    case 'cross': {
      if (minSize === 0) push(cells, centre.x, centre.y)
      for (let step = Math.max(1, minSize); step <= size; step++) {
        push(cells, centre.x + step, centre.y)
        push(cells, centre.x - step, centre.y)
        push(cells, centre.x, centre.y + step)
        push(cells, centre.x, centre.y - step)
      }
      return cells
    }

    case 'diagonal-cross': {
      if (minSize === 0) push(cells, centre.x, centre.y)
      for (let step = Math.max(1, minSize); step <= size; step++) {
        push(cells, centre.x + step, centre.y + step)
        push(cells, centre.x - step, centre.y - step)
        push(cells, centre.x + step, centre.y - step)
        push(cells, centre.x - step, centre.y + step)
      }
      return cells
    }

    case 'line': {
      // Carries on away from the caster, through the aimed cell.
      const dx = Math.sign(centre.x - origin.x)
      const dy = Math.sign(centre.y - origin.y)
      if (dx === 0 && dy === 0) return [target]
      if (minSize === 0) push(cells, centre.x, centre.y)
      for (let step = Math.max(1, minSize); step <= size; step++) {
        push(cells, centre.x + dx * step, centre.y + dy * step)
      }
      return cells
    }

    case 'perpendicular': {
      // A bar across the cast direction, centred on the aimed cell.
      const dx = Math.sign(centre.x - origin.x)
      const dy = Math.sign(centre.y - origin.y)
      const px = dy === 0 ? 0 : 1
      const py = dx === 0 ? 0 : 1
      push(cells, centre.x, centre.y)
      for (let step = 1; step <= size; step++) {
        push(cells, centre.x + px * step, centre.y + py * step)
        push(cells, centre.x - px * step, centre.y - py * step)
      }
      return cells
    }

    case 'ring': {
      for (let x = centre.x - size; x <= centre.x + size; x++) {
        for (let y = centre.y - size; y <= centre.y + size; y++) {
          const distance = gridDistance(x, y, centre.x, centre.y)
          if (distance > size || distance < Math.max(1, minSize)) continue
          push(cells, x, y)
        }
      }
      return cells
    }

    case 'circle':
    case 'unknown':
    default: {
      for (let x = centre.x - size; x <= centre.x + size; x++) {
        for (let y = centre.y - size; y <= centre.y + size; y++) {
          const distance = gridDistance(x, y, centre.x, centre.y)
          if (distance > size || distance < minSize) continue
          push(cells, x, y)
        }
      }
      return cells
    }
  }
}
