import type { CombatTargetStrategy } from '@dofemu/shared'
import type { DofusWindow } from '@/types/dofus-window'
import { sendMessage } from './game-bridge'

/**
 * Fight-side accessors. Same contract as game-bridge: probe the shapes known
 * to exist on the game build, return null/empty instead of throwing.
 */

type Dict = Record<string, unknown>

const MAP_WIDTH = 14

export interface Fighter {
  id: number
  teamId: number | null
  alive: boolean
  cellId: number | null
  life: number | null
  maxLife: number | null
  /** Action and movement points left this turn, when the game reports them. */
  ap: number | null
  mp: number | null
  name: string | null
}

export interface SpellInfo {
  id: number
  name: string | null
  level: number | null
  /** Maximum cast range in cells, when the game exposes it. */
  range: number | null
  minRange: number | null
}

function asDict(value: unknown): Dict | null {
  return value && typeof value === 'object' ? (value as Dict) : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function values(container: unknown): unknown[] {
  if (Array.isArray(container)) return container
  const dict = asDict(container)
  if (!dict) return []
  return Object.values(dict)
}

/**
 * Grid coordinates of a cell. Dofus lays 560 cells out as 40 interleaved rows
 * of 14, and distance between two cells is the Manhattan distance here.
 */
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

function getPlayerData(gameWindow: DofusWindow): Dict | null {
  return asDict(asDict(gameWindow.gui)?.playerData)
}

export function getFightManager(gameWindow: DofusWindow): Dict | null {
  return asDict(asDict(gameWindow.gui)?.fightManager)
}

export function isFightStarted(gameWindow: DofusWindow): boolean {
  const manager = getFightManager(gameWindow)
  if (typeof manager?.isFightStarted === 'boolean') return manager.isFightStarted
  const playerData = getPlayerData(gameWindow)
  if (typeof playerData?.isFighting === 'boolean') return playerData.isFighting
  return false
}

export function getMyFighterId(gameWindow: DofusWindow): number | null {
  const manager = getFightManager(gameWindow)
  const fromManager = asNumber(manager?.myFighterId) ?? asNumber(manager?.playerId)
  if (fromManager !== null) return fromManager
  return asNumber(asDict(getPlayerData(gameWindow)?.characterBaseInformations)?.id)
}

function toFighter(raw: unknown): Fighter | null {
  const dict = asDict(raw)
  if (!dict) return null

  const data = asDict(dict.data) ?? dict
  const id = asNumber(dict.id) ?? asNumber(data.contextualId) ?? asNumber(data.id)
  if (id === null) return null

  const disposition = asDict(data.disposition)
  const stats = asDict(data.stats)
  const alive = typeof data.alive === 'boolean' ? data.alive : dict.alive !== false

  return {
    id,
    teamId: asNumber(data.teamId) ?? asNumber(dict.teamId),
    alive,
    cellId: asNumber(disposition?.cellId) ?? asNumber(dict.cellId) ?? asNumber(asDict(dict.position)?.cellId),
    life: asNumber(stats?.lifePoints),
    maxLife: asNumber(stats?.maxLifePoints) ?? asNumber(stats?.lifePointsMax),
    ap: asNumber(stats?.actionPoints),
    mp: asNumber(stats?.movementPoints),
    name: asString(data.name) ?? asString(dict.name)
  }
}

export function getFighters(gameWindow: DofusWindow): Fighter[] {
  const manager = getFightManager(gameWindow)
  const containers = [manager?.fighters, manager?._fighters, manager?.fightersList]

  for (const container of containers) {
    const fighters = values(container)
      .map(toFighter)
      .filter((fighter): fighter is Fighter => fighter !== null)
    if (fighters.length > 0) return fighters
  }

  // Fall back to the actors of the current map that carry a team.
  const actorManager =
    asDict(asDict(gameWindow.isoEngine)?.actorManager) ?? asDict(gameWindow.actorManager)
  return values(actorManager?.actors)
    .map(toFighter)
    .filter((fighter): fighter is Fighter => fighter !== null && fighter.teamId !== null)
}

export function getMyFighter(gameWindow: DofusWindow): Fighter | null {
  const id = getMyFighterId(gameWindow)
  if (id === null) return null
  return getFighters(gameWindow).find((fighter) => fighter.id === id) ?? null
}

export function getEnemies(gameWindow: DofusWindow): Fighter[] {
  const me = getMyFighter(gameWindow)
  if (!me || me.teamId === null) return []
  return getFighters(gameWindow).filter(
    (fighter) => fighter.alive && fighter.teamId !== null && fighter.teamId !== me.teamId
  )
}

export function getAllies(gameWindow: DofusWindow): Fighter[] {
  const me = getMyFighter(gameWindow)
  if (!me || me.teamId === null) return []
  return getFighters(gameWindow).filter(
    (fighter) => fighter.alive && fighter.teamId === me.teamId && fighter.id !== me.id
  )
}

export function getSpells(gameWindow: DofusWindow): SpellInfo[] {
  const playerData = getPlayerData(gameWindow)
  const spellData =
    asDict(asDict(asDict(playerData?.characters)?.mainCharacter)?.spellData) ??
    asDict(playerData?.spellData)

  const containers = [spellData?.spells, spellData?.spellsBySpellId, spellData?.spellList]

  for (const container of containers) {
    const spells = values(container)
      .map((raw): SpellInfo | null => {
        const dict = asDict(raw)
        if (!dict) return null
        const spell = asDict(dict.spell)
        const id = asNumber(dict.id) ?? asNumber(dict.spellId) ?? asNumber(spell?.id)
        if (id === null) return null

        let name = asString(dict.name) ?? asString(spell?.nameId)
        if (!name && typeof dict.getName === 'function') {
          try {
            name = asString((dict.getName as () => unknown)())
          } catch {}
        }

        const spellLevel = asDict(dict.spellLevel) ?? asDict(spell?.spellLevel)

        return {
          id,
          name,
          level: asNumber(dict.level) ?? asNumber(spellLevel?.grade),
          range: asNumber(spellLevel?.range) ?? asNumber(dict.range) ?? asNumber(spell?.range),
          minRange: asNumber(spellLevel?.minRange) ?? asNumber(dict.minRange)
        }
      })
      .filter((spell): spell is SpellInfo => spell !== null)

    if (spells.length > 0) return spells
  }

  return []
}

/** Ranks the living enemies and returns the one a strategy would attack. */
export function pickTarget(
  gameWindow: DofusWindow,
  strategy: CombatTargetStrategy = 'nearest'
): Fighter | null {
  const enemies = getEnemies(gameWindow)
  if (enemies.length === 0) return null
  if (strategy === 'first') return enemies[0]

  if (strategy === 'weakest' || strategy === 'strongest') {
    const withLife = enemies.filter((enemy) => enemy.life !== null)
    const pool = withLife.length > 0 ? withLife : enemies
    return pool.reduce((best, enemy) => {
      const life = enemy.life ?? 0
      const bestLife = best.life ?? 0
      return strategy === 'weakest' ? (life < bestLife ? enemy : best) : life > bestLife ? enemy : best
    })
  }

  const me = getMyFighter(gameWindow)
  if (!me || me.cellId === null) return enemies[0]
  const positioned = enemies.filter((enemy) => enemy.cellId !== null)
  if (positioned.length === 0) return enemies[0]

  const from = me.cellId
  return positioned.reduce((best, enemy) =>
    cellDistance(from, enemy.cellId as number) < cellDistance(from, best.cellId as number) ? enemy : best
  )
}

export function castSpell(gameWindow: DofusWindow, spellId: number, cellId: number): void {
  sendMessage(gameWindow, 'GameActionFightCastRequestMessage', { spellId, cellId })
}

export function finishTurn(gameWindow: DofusWindow): void {
  sendMessage(gameWindow, 'GameFightTurnFinishMessage', {})
}

export function setFightReady(gameWindow: DofusWindow, isReady: boolean): void {
  sendMessage(gameWindow, 'GameFightReadyMessage', { isReady })
}

export function getSpellRange(gameWindow: DofusWindow, spellId: number): number | null {
  return getSpells(gameWindow).find((spell) => spell.id === spellId)?.range ?? null
}

/** Cells that can be walked on, as far as the map data lets us tell. */
export function isCellWalkable(gameWindow: DofusWindow, cellId: number): boolean {
  if (cellId < 0 || cellId >= 560) return false

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
  const flags = asNumber(cell.l)
  if (flags !== null) return (flags & 1) !== 0

  return true
}

/**
 * Cell to walk to in order to bring `target` within `range`, or null when the
 * character already is in range or cannot get there with the movement points
 * it has left.
 *
 * Distances are grid distances: obstacles and the real path length are not
 * accounted for, so the move is a best effort and the caller should re-check
 * the distance afterwards.
 */
export function findApproachCell(
  gameWindow: DofusWindow,
  target: Fighter,
  range: number,
  movementPoints: number
): number | null {
  const me = getMyFighter(gameWindow)
  if (!me || me.cellId === null || target.cellId === null) return null
  if (movementPoints <= 0) return null
  if (cellDistance(me.cellId, target.cellId) <= range) return null

  const occupied = new Set(
    getFighters(gameWindow)
      .filter((fighter) => fighter.alive && fighter.cellId !== null)
      .map((fighter) => fighter.cellId as number)
  )

  const from = me.cellId
  const to = target.cellId
  let best: { cellId: number; toTarget: number; cost: number } | null = null

  for (let cellId = 0; cellId < 560; cellId++) {
    if (cellId === from || occupied.has(cellId)) continue

    const cost = cellDistance(from, cellId)
    if (cost > movementPoints) continue

    const toTarget = cellDistance(cellId, to)
    if (toTarget > range) continue
    if (!isCellWalkable(gameWindow, cellId)) continue

    if (
      !best ||
      toTarget > best.toTarget ||
      (toTarget === best.toTarget && cost < best.cost)
    ) {
      // Prefer staying as far as the range allows, and walking as little as possible.
      best = { cellId, toTarget, cost }
    }
  }

  return best?.cellId ?? null
}
