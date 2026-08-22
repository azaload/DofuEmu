import type { CombatSpell } from '@dofemu/shared'
import type { DofusWindow } from '@/types/dofus-window'
import { areCellsAligned, cellCoordinates, cellDistance, hasLineOfSight, reachableCells } from './cells'
import {
  getAllies,
  getEnemies,
  getFighters,
  getMyFighter,
  getSpells,
  tacklingEnemies,
  type Fighter,
  type SpellInfo
} from './fight-bridge'

/**
 * The fight, compact enough to hand to a small model.
 *
 * Everything hard is precomputed here — reachable cells, distances, lines of
 * sight — so the model only has to choose among moves and casts that are
 * already legal, which is what makes a one-billion-parameter model usable.
 */

export interface StateFighter {
  id: number
  name: string | null
  cellId: number | null
  x: number | null
  y: number | null
  life: number | null
  maxLife: number | null
  distance: number | null
  lineOfSight: boolean
  aligned: boolean
}

export interface StateSpell {
  id: number
  name: string | null
  range: number
  minRange: number
  /** Enemies this spell can hit right now, by fighter id. */
  targets: number[]
  self: boolean
  /** Pushes its target away, which breaks melee without paying a tackle. */
  push: boolean
}

export interface StateCell {
  cellId: number
  cost: number
  /** Distance to the closest living enemy from there. */
  enemyDistance: number
  /** Enemy ids this cell can see. */
  sees: number[]
  alignedWith: number[]
}

export interface FightChallenge {
  id: number
  name: string | null
  /** Fighter the challenge points at, when it names one. */
  targetId: number | null
}

export interface FightState {
  turn: number
  me: {
    id: number | null
    name: string | null
    cellId: number | null
    life: number | null
    maxLife: number | null
    ap: number | null
    mp: number | null
    /** Enemies in contact. Leaving their reach is tackled. */
    tackledBy: number[]
    /** False while held in contact: no move action may be planned. */
    canMove: boolean
  }
  spells: StateSpell[]
  enemies: StateFighter[]
  allies: StateFighter[]
  /** Best cells to stand on, cheapest first, capped for the prompt. */
  cells: StateCell[]
  challenges: FightChallenge[]
}

const MAX_CELLS = 12

function describe(gameWindow: DofusWindow, from: number | null, fighter: Fighter): StateFighter {
  const point = fighter.cellId !== null ? cellCoordinates(fighter.cellId) : null
  return {
    id: fighter.id,
    name: fighter.name,
    cellId: fighter.cellId,
    x: point?.x ?? null,
    y: point?.y ?? null,
    life: fighter.life,
    maxLife: fighter.maxLife,
    distance: from !== null && fighter.cellId !== null ? cellDistance(from, fighter.cellId) : null,
    lineOfSight:
      from !== null && fighter.cellId !== null ? hasLineOfSight(gameWindow, from, fighter.cellId) : false,
    aligned: from !== null && fighter.cellId !== null ? areCellsAligned(from, fighter.cellId) : false
  }
}

/** Range to assume for a spell: the one configured, then the game's, then a fallback. */
function rangeOf(spell: SpellInfo, configured: CombatSpell | undefined, fallback: number): number {
  if (configured && typeof configured.range === 'number' && configured.range >= 0) {
    return configured.range
  }
  return spell.range ?? fallback
}

export function buildFightState(
  gameWindow: DofusWindow,
  options: { turn: number; combo: CombatSpell[]; fallbackRange: number; tackleAware?: boolean }
): FightState {
  const me = getMyFighter(gameWindow)
  const from = me?.cellId ?? null
  const enemies = getEnemies(gameWindow)
  const allies = getAllies(gameWindow)

  const configured = new Map(options.combo.map((spell) => [spell.id, spell]))
  const known = getSpells(gameWindow)

  // The combo drives the list: those are the spells the character will use.
  const spells: StateSpell[] = options.combo.map((entry) => {
    const spell = known.find((candidate) => candidate.id === entry.id)
    const range = rangeOf(spell ?? { id: entry.id, name: entry.name, level: null, range: null, minRange: null }, entry, options.fallbackRange)
    const minRange = spell?.minRange ?? 0

    const targets = from === null
      ? []
      : enemies
          .filter((enemy) => {
            if (enemy.cellId === null) return false
            const distance = cellDistance(from, enemy.cellId)
            return distance >= minRange && distance <= range && hasLineOfSight(gameWindow, from, enemy.cellId)
          })
          .map((enemy) => enemy.id)

    return {
      id: entry.id,
      name: entry.name || spell?.name || null,
      range,
      minRange,
      targets,
      self: entry.self === true,
      push: entry.push === true
    }
  })

  const occupied = new Set(
    getFighters(gameWindow)
      .filter((fighter) => fighter.alive && fighter.cellId !== null && fighter.cellId !== from)
      .map((fighter) => fighter.cellId as number)
  )

  // No cells are offered while held: a move would be tackled.
  const cells: StateCell[] = []
  if (from !== null && (me?.mp ?? 0) > 0 && !(options.tackleAware !== false && tacklingEnemies(enemies, from).length > 0)) {
    const reachable = [...reachableCells(gameWindow, from, me?.mp ?? 0, occupied).values()]
      .filter((entry) => entry.cellId !== from)
      .sort((a, b) => a.cost - b.cost)

    for (const entry of reachable) {
      if (cells.length >= MAX_CELLS) break
      const sees = enemies
        .filter((enemy) => enemy.cellId !== null && hasLineOfSight(gameWindow, entry.cellId, enemy.cellId))
        .map((enemy) => enemy.id)
      const alignedWith = enemies
        .filter((enemy) => enemy.cellId !== null && areCellsAligned(entry.cellId, enemy.cellId))
        .map((enemy) => enemy.id)
      const enemyDistance = enemies.reduce((closest, enemy) => {
        if (enemy.cellId === null) return closest
        return Math.min(closest, cellDistance(entry.cellId, enemy.cellId))
      }, Number.MAX_SAFE_INTEGER)

      cells.push({
        cellId: entry.cellId,
        cost: entry.cost,
        enemyDistance: enemyDistance === Number.MAX_SAFE_INTEGER ? -1 : enemyDistance,
        sees,
        alignedWith
      })
    }
  }

  const tackledBy = from === null ? [] : tacklingEnemies(enemies, from).map((enemy) => enemy.id)
  const held = options.tackleAware !== false && tackledBy.length > 0

  return {
    turn: options.turn,
    me: {
      id: me?.id ?? null,
      name: me?.name ?? null,
      cellId: from,
      life: me?.life ?? null,
      maxLife: me?.maxLife ?? null,
      ap: me?.ap ?? null,
      mp: me?.mp ?? null,
      tackledBy,
      canMove: !held && (me?.mp ?? 0) > 0
    },
    spells,
    enemies: enemies.map((enemy) => describe(gameWindow, from, enemy)),
    allies: allies.map((ally) => describe(gameWindow, from, ally)),
    cells,
    challenges: readChallenges(gameWindow)
  }
}

type Dict = Record<string, unknown>

function asDict(value: unknown): Dict | null {
  return value && typeof value === 'object' ? (value as Dict) : null
}

/** Challenges the fight is running, when the client keeps them somewhere readable. */
export function readChallenges(gameWindow: DofusWindow): FightChallenge[] {
  const gui = asDict(gameWindow.gui)
  const containers = [
    asDict(gui?.challengeUi)?.challenges,
    asDict(gui?.fightManager)?.challenges,
    asDict(asDict(gui?.timeline)?.challenges)
  ]

  for (const container of containers) {
    if (!container || typeof container !== 'object') continue
    const list = Array.isArray(container) ? container : Object.values(container)
    const challenges = list
      .map((raw): FightChallenge | null => {
        const dict = asDict(raw)
        if (!dict) return null
        const id = typeof dict.id === 'number' ? dict.id : typeof dict.challengeId === 'number' ? dict.challengeId : null
        if (id === null) return null
        return {
          id,
          name: typeof dict.name === 'string' ? dict.name : null,
          targetId: typeof dict.targetId === 'number' ? dict.targetId : null
        }
      })
      .filter((challenge): challenge is FightChallenge => challenge !== null)

    if (challenges.length > 0) return challenges
  }

  return []
}
