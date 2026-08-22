import type { DofusWindow } from '@/types/dofus-window'

/**
 * Low-level accessors on top of the game window.
 *
 * The game internals are minified and change between builds, so every helper
 * probes a few known shapes and returns null instead of throwing when it can
 * not find what it is looking for. Scripts get a clear error from the API layer
 * rather than an obscure TypeError from inside the game bundle.
 */

export type Direction = 'top' | 'bottom' | 'left' | 'right'

export const DIRECTIONS: Direction[] = ['top', 'bottom', 'left', 'right']

const DIRECTION_ALIASES: Record<string, Direction> = {
  top: 'top',
  up: 'top',
  north: 'top',
  n: 'top',
  t: 'top',
  bottom: 'bottom',
  down: 'bottom',
  south: 'bottom',
  s: 'bottom',
  b: 'bottom',
  left: 'left',
  west: 'left',
  w: 'left',
  l: 'left',
  right: 'right',
  east: 'right',
  e: 'right',
  r: 'right'
}

/** Bit of `mapChangeData` that flags a cell as an exit towards a direction. */
const MAP_CHANGE_BITS: Record<Direction, number> = {
  right: 1,
  bottom: 4,
  left: 16,
  top: 64
}

const NEIGHBOUR_KEYS: Record<Direction, string> = {
  top: 'topNeighbourId',
  bottom: 'bottomNeighbourId',
  left: 'leftNeighbourId',
  right: 'rightNeighbourId'
}

type Dict = Record<string, unknown>

export interface EventEmitterLike {
  on: (event: string, cb: (...args: unknown[]) => void) => void
  removeListener?: (event: string, cb: (...args: unknown[]) => void) => void
  off?: (event: string, cb: (...args: unknown[]) => void) => void
}

export interface MapInfo {
  id: number | null
  x: number | null
  y: number | null
  subAreaId: number | null
  neighbours: Record<Direction, number | null>
}

export interface CharacterInfo {
  id: number | null
  name: string | null
  level: number | null
  kamas: number | null
}

export function parseDirection(value: string): Direction {
  const direction = DIRECTION_ALIASES[value.trim().toLowerCase()]
  if (!direction) {
    throw new Error(`Unknown direction "${value}" (use top, bottom, left or right)`)
  }
  return direction
}

function asDict(value: unknown): Dict | null {
  return value && typeof value === 'object' ? (value as Dict) : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function getConnectionManager(gameWindow: DofusWindow): EventEmitterLike | null {
  const manager = asDict(gameWindow.dofus?.connectionManager)
  return manager && typeof manager.on === 'function' ? (manager as unknown as EventEmitterLike) : null
}

export function getGuiEmitter(gameWindow: DofusWindow): EventEmitterLike | null {
  const gui = asDict(gameWindow.gui)
  return gui && typeof gui.on === 'function' ? (gui as unknown as EventEmitterLike) : null
}

export function addListener(
  source: EventEmitterLike | null,
  event: string,
  handler: (...args: unknown[]) => void
): () => void {
  if (!source) return () => {}
  source.on(event, handler)
  return () => {
    if (source.removeListener) source.removeListener(event, handler)
    else source.off?.(event, handler)
  }
}

export function sendMessage(gameWindow: DofusWindow, name: string, data: unknown): void {
  const dofus = asDict(gameWindow.dofus)
  const send = dofus?.sendMessage
  if (typeof send !== 'function') {
    throw new Error('The game connection is not ready (dofus.sendMessage is unavailable)')
  }
  ;(send as (name: string, data: unknown) => void).call(dofus, name, data ?? {})
}

function getPlayerData(gameWindow: DofusWindow): Dict | null {
  return asDict(asDict(gameWindow.gui)?.playerData)
}

export function getCharacter(gameWindow: DofusWindow): CharacterInfo {
  const playerData = getPlayerData(gameWindow)
  const base = asDict(playerData?.characterBaseInformations)
  const characteristics = asDict(playerData?.characters) ?? asDict(playerData?.characteristics)

  return {
    id: asNumber(base?.id),
    name: typeof base?.name === 'string' ? base.name : null,
    level: asNumber(base?.level) ?? asNumber(playerData?.level),
    kamas: asNumber(characteristics?.kamas) ?? asNumber(playerData?.kamas)
  }
}

export function isInFight(gameWindow: DofusWindow): boolean {
  const playerData = getPlayerData(gameWindow)
  if (typeof playerData?.isFighting === 'boolean') return playerData.isFighting
  const fightState = asDict(playerData?.fightState)
  if (typeof fightState?.isFighting === 'boolean') return fightState.isFighting
  return false
}

function readFlag(owner: Dict | null, key: string): boolean | null {
  const value = owner?.[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'function') {
    try {
      const result = (value as () => unknown).call(owner)
      return typeof result === 'boolean' ? result : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Whether the character is in game.
 *
 * `gui.isConnected` is not exposed the same way on every build — it can be a
 * method, a boolean, or missing entirely — so knowing who we are and where we
 * stand is taken as the answer first. A missing indicator used to read as
 * "disconnected", which stopped scripts on their first line.
 */
export function isConnected(gameWindow: DofusWindow): boolean {
  const gui = asDict(gameWindow.gui)

  if (getCharacter(gameWindow).name !== null && getMapInfo(gameWindow).id !== null) return true

  const indicators = [
    readFlag(gui, 'isConnected'),
    readFlag(asDict(gui?.playerData), 'isConnected'),
    readFlag(asDict(gameWindow.dofus?.connectionManager), 'connected'),
    readFlag(asDict(gameWindow.dofus?.connectionManager), 'isConnected')
  ]

  if (indicators.some((flag) => flag === true)) return true
  if (indicators.some((flag) => flag === false)) return false

  // No indicator at all: the game window exists, so treat it as usable.
  return true
}

function getMapRenderer(gameWindow: DofusWindow): Dict | null {
  return asDict(asDict(gameWindow.isoEngine)?.mapRenderer)
}

export function getMapInfo(gameWindow: DofusWindow): MapInfo {
  const mapRenderer = getMapRenderer(gameWindow)
  const map = asDict(mapRenderer?.map)

  const neighbours = {} as Record<Direction, number | null>
  for (const direction of DIRECTIONS) {
    const raw = asNumber(map?.[NEIGHBOUR_KEYS[direction]])
    neighbours[direction] = raw !== null && raw > 0 ? raw : null
  }

  return {
    id: asNumber(mapRenderer?.mapId) ?? asNumber(map?.id),
    x: asNumber(map?.posX) ?? asNumber(mapRenderer?.worldX),
    y: asNumber(map?.posY) ?? asNumber(mapRenderer?.worldY),
    subAreaId: asNumber(map?.subareaId) ?? asNumber(map?.subAreaId),
    neighbours
  }
}

function getUserActor(gameWindow: DofusWindow): Dict | null {
  const actorManager =
    asDict(asDict(gameWindow.isoEngine)?.actorManager) ?? asDict(gameWindow.actorManager)
  return asDict(actorManager?.userActor)
}

export function getCellId(gameWindow: DofusWindow): number | null {
  const actor = getUserActor(gameWindow)
  return (
    asNumber(actor?.cellId) ??
    asNumber(asDict(actor?.position)?.cellId) ??
    asNumber(asDict(asDict(actor?.data)?.disposition)?.cellId)
  )
}

export function isMoving(gameWindow: DofusWindow): boolean {
  const actor = getUserActor(gameWindow)
  return actor?.isMoving === true || actor?.moving === true
}

/** Cells of the current map flagged as an exit towards `direction`. */
export function getMapChangeCells(gameWindow: DofusWindow, direction: Direction): number[] {
  const map = asDict(getMapRenderer(gameWindow)?.map)
  const cells = map?.cells
  if (!cells || typeof cells !== 'object') return []

  const bit = MAP_CHANGE_BITS[direction]
  const entries = Array.isArray(cells)
    ? cells.map((cell, index) => [index, cell] as const)
    : Object.entries(cells).map(([key, cell]) => [Number(key), cell] as const)

  const result: number[] = []
  for (const [cellId, cell] of entries) {
    const changeData = asNumber(asDict(cell)?.mapChangeData)
    if (changeData !== null && (changeData & bit) !== 0) result.push(cellId)
  }
  return result
}

/**
 * Asks the iso engine to walk the character to `cellId`.
 * Returns false when no known movement entry point exists on this game build.
 */
export function requestMoveToCell(gameWindow: DofusWindow, cellId: number): boolean {
  const isoEngine = asDict(gameWindow.isoEngine)
  if (!isoEngine) return false

  const candidates: Array<[string, unknown[]]> = [
    ['moveTo', [cellId]],
    ['movePlayerOnMap', [cellId, true]],
    ['_movePlayerOnMap', [cellId, true]]
  ]

  for (const [method, args] of candidates) {
    const fn = isoEngine[method]
    if (typeof fn === 'function') {
      ;(fn as (...a: unknown[]) => void).apply(isoEngine, args)
      return true
    }
  }

  return false
}

export interface MonsterGroup {
  id: number
  cellId: number | null
  /** Sum of the levels of every monster in the group. */
  level: number | null
  /** Level of the leader alone. */
  leaderLevel: number | null
  size: number
}

function toMonsterGroup(raw: unknown): MonsterGroup | null {
  const dict = asDict(raw)
  const data = asDict(dict?.data) ?? dict
  const staticInfos = asDict(data?.staticInfos)
  const leader = asDict(staticInfos?.mainCreatureLightInfos)

  // Only monster groups carry mainCreatureLightInfos.
  if (!leader) return null

  const id = asNumber(dict?.id) ?? asNumber(data?.contextualId)
  if (id === null) return null

  const underlings = Array.isArray(staticInfos?.underlings) ? staticInfos.underlings : []
  const leaderLevel = asNumber(leader.level)
  const levels = [leaderLevel, ...underlings.map((underling) => asNumber(asDict(underling)?.level))]
  const known = levels.filter((level): level is number => level !== null)

  return {
    id,
    cellId: asNumber(asDict(data?.disposition)?.cellId) ?? asNumber(dict?.cellId),
    level: known.length > 0 ? known.reduce((total, level) => total + level, 0) : null,
    leaderLevel,
    size: 1 + underlings.length
  }
}

/** Monster groups standing on the current map. */
export function getMonsterGroups(gameWindow: DofusWindow): MonsterGroup[] {
  const actorManager =
    asDict(asDict(gameWindow.isoEngine)?.actorManager) ?? asDict(gameWindow.actorManager)
  const actors = actorManager?.actors
  if (!actors || typeof actors !== 'object') return []

  const list = Array.isArray(actors) ? actors : Object.values(actors)
  return list
    .map(toMonsterGroup)
    .filter((group): group is MonsterGroup => group !== null)
}

export function attackMonsterGroup(gameWindow: DofusWindow, groupId: number): void {
  sendMessage(gameWindow, 'GameRolePlayAttackMonsterRequestMessage', { monsterGroupId: groupId })
}

export function getInteractiveElements(gameWindow: DofusWindow): Array<Dict> {
  const mapRenderer = getMapRenderer(gameWindow)
  const elements = mapRenderer?.interactiveElements
  if (!elements || typeof elements !== 'object') return []
  const list = Array.isArray(elements) ? elements : Object.values(elements)
  return list.filter((element): element is Dict => !!asDict(element))
}
