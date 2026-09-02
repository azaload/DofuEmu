import type { CombatPositioning, CombatTargetStrategy } from '@dofemu/shared'
import type { DofusWindow } from '@/types/dofus-window'
import {
  areCellsAligned,
  cellDistance,
  directionBetween,
  hasLineOfSight,
  isCellWalkable,
  reachableCells
} from './cells'
import { sendMessage } from './game-bridge'

export { areCellsAligned, cellCoordinates, cellDistance, isCellWalkable } from './cells'

/**
 * Fight-side accessors. Same contract as game-bridge: probe the shapes known
 * to exist on the game build, return null/empty instead of throwing.
 */

type Dict = Record<string, unknown>

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
  /**
   * A creature another fighter called into the fight rather than one the
   * fight started with.
   *
   * Worth knowing because killing one buys nothing: it leaves on its own, and
   * the monster that called it is still standing and still summoning.
   */
  summoned: boolean
  /** The fighter that called it in, when the fight says which. */
  summonerId: number | null
  /** Raw stats block, where the resistances live. */
  stats: unknown
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
  // A fighter the client still flags alive but whose life has run out is a
  // corpse: aiming at one wastes the spell, and the client only clears the
  // flag once the death animation has played.
  const life = asNumber(stats?.lifePoints)
  const flagged = typeof data.alive === 'boolean' ? data.alive : dict.alive !== false
  const alive = flagged && (life === null || life > 0)

  return {
    id,
    teamId: asNumber(data.teamId) ?? asNumber(dict.teamId),
    alive,
    cellId: asNumber(disposition?.cellId) ?? asNumber(dict.cellId) ?? asNumber(asDict(dict.position)?.cellId),
    life,
    maxLife: asNumber(stats?.maxLifePoints) ?? asNumber(stats?.lifePointsMax),
    ap: asNumber(stats?.actionPoints),
    mp: asNumber(stats?.movementPoints),
    name: asString(data.name) ?? asString(dict.name),
    summoned: readSummoned(dict, data, stats),
    summonerId: asNumber(stats?.summoner) ?? asNumber(data.summonerId) ?? null,
    stats
  }
}

/**
 * Whether this fighter was called into the fight by another.
 *
 * The protocol says it outright on the fighter's statistics, but not every
 * build exposes the same field: some carry the flag, some only the id of the
 * summoner. Either is enough, and neither being there reads as "not a summon"
 * — treating a real monster as one would leave it alive for the whole fight.
 */
function readSummoned(dict: Dict, data: Dict, stats: Dict | null): boolean {
  if (typeof stats?.summoned === 'boolean') return stats.summoned
  if (typeof data.summoned === 'boolean') return data.summoned
  if (typeof dict.summoned === 'boolean') return dict.summoned

  const summoner = asNumber(stats?.summoner) ?? asNumber(data.summonerId)
  return summoner !== null && summoner !== 0
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

/**
 * The fighters worth attacking first: the ones nobody called in.
 *
 * A summon is not a target, it is a delay. Killing one costs the same points
 * as killing the monster that called it, buys nothing that a turn of waiting
 * would not, and leaves that monster free to call another. So they are only
 * aimed at when there is nothing else to aim at — and then they are, because
 * a turn spent casting nothing is worse still.
 */
export function realTargetsFirst<T extends { summoned: boolean }>(fighters: T[]): T[] {
  const real = fighters.filter((fighter) => !fighter.summoned)
  return real.length > 0 ? real : fighters
}

/** Ranks the living enemies and returns the one a strategy would attack. */
/** Living enemies, best first for the chosen strategy. */
export function orderTargets(
  gameWindow: DofusWindow,
  strategy: CombatTargetStrategy = 'nearest'
): Fighter[] {
  const enemies = getEnemies(gameWindow)
  if (enemies.length <= 1 || strategy === 'first') return enemies

  if (strategy === 'weakest' || strategy === 'strongest') {
    return [...enemies].sort((a, b) => {
      const left = a.life ?? 0
      const right = b.life ?? 0
      return strategy === 'weakest' ? left - right : right - left
    })
  }

  const me = getMyFighter(gameWindow)
  if (!me || me.cellId === null) return enemies

  const from = me.cellId
  return [...enemies].sort((a, b) => {
    const left = a.cellId === null ? Number.MAX_SAFE_INTEGER : cellDistance(from, a.cellId)
    const right = b.cellId === null ? Number.MAX_SAFE_INTEGER : cellDistance(from, b.cellId)
    return left - right
  })
}

/** Ranks the living enemies and returns the one a strategy would attack. */
export function pickTarget(
  gameWindow: DofusWindow,
  strategy: CombatTargetStrategy = 'nearest'
): Fighter | null {
  return orderTargets(gameWindow, strategy)[0] ?? null
}

/** Enemies our character can reach with a spell of `range` from where it stands. */
export function targetsInRange(
  gameWindow: DofusWindow,
  range: number,
  strategy: CombatTargetStrategy = 'nearest'
): Fighter[] {
  const me = getMyFighter(gameWindow)
  if (!me || me.cellId === null) return []
  const from = me.cellId

  return orderTargets(gameWindow, strategy).filter(
    (enemy) => enemy.cellId !== null && cellDistance(from, enemy.cellId) <= range
  )
}

export function sendFightMove(gameWindow: DofusWindow, path: number[]): boolean {
  if (path.length < 2) return false

  const keyMovements: number[] = []
  for (let index = 0; index < path.length; index++) {
    const from = path[index]
    const next = path[index + 1]
    const direction = next === undefined ? directionBetween(path[index - 1], from) : directionBetween(from, next)
    if (direction === null) return false
    keyMovements.push((direction << 12) | from)
  }

  const mapId = asNumber(asDict(asDict(gameWindow.isoEngine)?.mapRenderer)?.mapId)
  sendMessage(gameWindow, 'GameMapMovementRequestMessage', {
    keyMovements,
    mapId: mapId ?? 0
  })
  return true
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

export interface PositionOptions {
  /** Favour cells lined up with the target, for line-only spells. */
  preferLineUp?: boolean
  /** Keep as far from enemies as the range allows, or walk right up to them. */
  positioning?: CombatPositioning
  /**
   * Never move while a monster is in contact. Leaving a held cell is tackled:
   * it costs more than the distance walked, can cost action points, and often
   * fails outright — so the turn is spent casting instead.
   */
  tackleAware?: boolean
  /**
   * What this move is for.
   *
   * "approach" only moves for something a cast needs — getting in range, or
   * onto a line — and leaves the points alone otherwise. "retreat" only backs
   * away, and only while staying in range. Splitting the two lets a turn spend
   * its action points first and its movement afterwards, when it knows which
   * monsters are left standing.
   */
  purpose?: 'approach' | 'retreat' | 'both'
}

export interface PositionResult {
  cellId: number
  /** Cells to walk through, ready for sendFightMove(). */
  path: number[]
  /** Nothing blocks the view of the target from there. */
  sees: boolean
  /** The target is within range from there, with a clear line. */
  inRange: boolean
  aligned: boolean
  /** Movement points the move costs. */
  cost: number
  distanceToTarget: number
  /** Distance to the closest living enemy from there. */
  distanceToClosestEnemy: number
}

/** Enemies in contact with `cellId` — the ones that tackle a departure. */
export function tacklingEnemies(enemies: Fighter[], cellId: number): Fighter[] {
  return enemies.filter((enemy) => enemy.cellId !== null && cellDistance(cellId, enemy.cellId) === 1)
}

/** Distance from `cellId` to the nearest living enemy. */
function closestEnemyDistance(enemies: Fighter[], cellId: number): number {
  let closest = Number.MAX_SAFE_INTEGER
  for (const enemy of enemies) {
    if (enemy.cellId === null) continue
    closest = Math.min(closest, cellDistance(cellId, enemy.cellId))
  }
  return closest
}

/**
 * Where to stand to cast at `target` with a spell of `range`.
 *
 * In "keep-distance" the character stays as far from every enemy as the range
 * allows — a melee monster next to us is a reason to step back, not to stay.
 * In "close-in" it walks up to the target instead. When nothing brings the
 * target in range, both modes close as much distance as the movement points
 * allow rather than standing still.
 *
 * Distances are grid distances: obstacles and the real path length are not
 * accounted for, so the move is a best effort and the caller should re-check
 * where the character actually landed.
 */
export function findPositionCell(
  gameWindow: DofusWindow,
  target: Fighter,
  range: number,
  movementPoints: number,
  options: PositionOptions = {}
): PositionResult | null {
  const me = getMyFighter(gameWindow)
  if (!me || me.cellId === null || target.cellId === null) return null
  if (movementPoints <= 0) return null

  const preferLineUp = options.preferLineUp !== false
  const keepDistance = (options.positioning ?? 'keep-distance') === 'keep-distance'
  const from = me.cellId
  const to = target.cellId

  const enemies = getEnemies(gameWindow)
  // A monster in contact holds the character: leaving is tackled, costs more
  // than the distance walked and often fails outright, so no move is planned
  // at all and the turn goes to casting.
  if (options.tackleAware !== false && tacklingEnemies(enemies, from).length > 0) return null

  const budget = movementPoints

  const occupied = new Set(
    getFighters(gameWindow)
      .filter((fighter) => fighter.alive && fighter.cellId !== null)
      .map((fighter) => fighter.cellId as number)
  )

  const occupiedByFighters = new Set(
    getFighters(gameWindow)
      .filter((fighter) => fighter.alive && fighter.cellId !== null && fighter.cellId !== from)
      .map((fighter) => fighter.cellId as number)
  )

  // Real paths, not straight lines: the server refuses a move it cannot walk.
  const reachable = reachableCells(gameWindow, from, budget, occupiedByFighters)

  const startDistance = cellDistance(from, to)
  const startSees = hasLineOfSight(gameWindow, from, to)
  const startInRange = startDistance <= range && startSees
  const startEnemyDistance = closestEnemyDistance(enemies, from)
  const startAligned = areCellsAligned(from, to) && startSees

  const score = (cellId: number, cost: number, path: number[]): PositionResult => {
    // Being in range is not enough: a spell needs to see its target, so a cell
    // whose line is blocked is no better than one out of reach.
    const sees = hasLineOfSight(gameWindow, cellId, to)
    return {
      cellId,
      path,
      sees,
      inRange: cellDistance(cellId, to) <= range && sees,
      aligned: areCellsAligned(cellId, to) && sees,
      cost,
      distanceToTarget: cellDistance(cellId, to),
      distanceToClosestEnemy: closestEnemyDistance(enemies, cellId)
    }
  }

  const candidates: PositionResult[] = []
  for (const entry of reachable.values()) {
    if (entry.cellId !== from && occupied.has(entry.cellId)) continue
    candidates.push(score(entry.cellId, entry.cost, entry.path))
  }

  const anyInRange = candidates.some((candidate) => candidate.inRange)
  const anySees = candidates.some((candidate) => candidate.sees)

  const better = (a: PositionResult, b: PositionResult): boolean => {
    // Being able to cast comes first.
    if (anyInRange && a.inRange !== b.inRange) return a.inRange

    if (!anyInRange) {
      // Nothing can be cast from anywhere we can walk to. A clear line is then
      // the only thing worth walking for: a wall between us and the pack is
      // stepped around, whatever the map looks like, rather than stood behind
      // for the rest of the fight.
      if (a.sees !== b.sees) return a.sees

      // Closing in is right, but closing all the way is not: a ranged
      // character that walks into contact spends the next turn tackled
      // instead of shooting. The cell wanted is the one at the edge of our
      // own range, not the one nearest the monster.
      const overshoot = (choice: PositionResult) =>
        keepDistance && anySees ? Math.abs(choice.distanceToTarget - range) : choice.distanceToTarget

      if (overshoot(a) !== overshoot(b)) return overshoot(a) < overshoot(b)
      if (keepDistance && a.distanceToClosestEnemy !== b.distanceToClosestEnemy) {
        // Never end a step inside another monster's arms for the sake of one.
        const safe = (choice: PositionResult) => choice.distanceToClosestEnemy > 1
        if (safe(a) !== safe(b)) return safe(a)
      }
      if (preferLineUp && a.aligned !== b.aligned) return a.aligned
      return a.cost < b.cost
    }

    // Lining up comes first when asked for: a line spell that cannot be cast
    // makes the safest cell worthless.
    if (preferLineUp && a.aligned !== b.aligned) return a.aligned

    if (keepDistance && a.distanceToClosestEnemy !== b.distanceToClosestEnemy) {
      return a.distanceToClosestEnemy > b.distanceToClosestEnemy
    }
    if (!keepDistance && a.distanceToTarget !== b.distanceToTarget) {
      return a.distanceToTarget < b.distanceToTarget
    }
    return a.cost < b.cost
  }

  let best = candidates[0]
  for (const candidate of candidates.slice(1)) {
    if (better(candidate, best)) best = candidate
  }

  if (best.cellId === from) return null

  // Already able to cast: only move for something the cast needs — lining up,
  // or backing away from the enemies. Walking closer for its own sake spends
  // points and invites melee.
  const gainsAlignment = preferLineUp && best.aligned && !startAligned
  const gainsDistance = keepDistance && best.distanceToClosestEnemy > startEnemyDistance
  // Stepping out from behind cover is worth the walk on its own, whichever
  // way it takes us: without a line there is nothing to cast at all.
  const gainsSight = best.sees && !startSees
  const purpose = options.purpose ?? 'both'

  // Never give up a castable position, and never move for nothing.
  if (startInRange && !best.inRange) return null
  if (!startInRange && !best.inRange && !gainsSight && best.distanceToTarget >= startDistance) {
    return null
  }

  // Backing away is worth movement points only once the spells are spent: a
  // monster killed in the meantime frees the points for reaching another one.
  if (purpose === 'approach' && !gainsAlignment && !gainsSight && startInRange && best.inRange) {
    return null
  }
  if (purpose === 'retreat' && (!gainsDistance || !best.inRange)) return null

  if (startInRange && best.inRange && !gainsAlignment && !gainsDistance) return null

  return best
}

/** Cells the placement phase offers, when the fight told us about them. */
export function sendPlacementMove(gameWindow: DofusWindow, cellId: number): void {
  sendMessage(gameWindow, 'GameFightPlacementPositionRequestMessage', { cellId })
}

/**
 * The cells the game is offering to start the fight on.
 *
 * They normally arrive as a message during the preparation phase, but a mod
 * that loads late — or a build that names the message differently — never sees
 * it. So the client is asked directly as well, and what could not be found is
 * reported with the keys it does expose, which is what makes a missing one
 * fixable rather than a mystery.
 */
export interface PlacementCells {
  cells: number[]
  source: string
  /** Fields that look related, listed when nothing was found. */
  hints: string[]
}

const PLACEMENT_FIELDS = [
  'possiblePlacementCells',
  'placementCells',
  '_placementCells',
  'placementPositions',
  'possiblePositions',
  'fightSpawnCells',
  'spawnCells'
]

const PLACEMENT_METHODS = ['getPossiblePlacementCells', 'getPlacementCells', 'getSpawnCells']

function asCellList(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  const cells = value
    .map((entry) => (typeof entry === 'number' ? entry : asNumber(asDict(entry)?.cellId)))
    .filter((cellId): cellId is number => cellId !== null && cellId >= 0)
  return cells.length > 0 ? cells : null
}

export function readPlacementCells(gameWindow: DofusWindow): PlacementCells {
  const gui = asDict(gameWindow.gui)
  const isoEngine = asDict(gameWindow.isoEngine)
  const owners: Array<[string, Dict | null]> = [
    ['fightManager', asDict(gui?.fightManager)],
    ['mapRenderer', asDict(isoEngine?.mapRenderer)],
    ['actorManager', asDict(isoEngine?.actorManager)],
    ['gui', gui]
  ]

  for (const [label, owner] of owners) {
    if (!owner) continue

    for (const field of PLACEMENT_FIELDS) {
      const cells = asCellList(owner[field])
      if (cells) return { cells, source: `${label}.${field}`, hints: [] }
    }

    for (const method of PLACEMENT_METHODS) {
      const fn = owner[method]
      if (typeof fn !== 'function') continue
      try {
        const cells = asCellList((fn as () => unknown).call(owner))
        if (cells) return { cells, source: `${label}.${method}()`, hints: [] }
      } catch {}
    }
  }

  const hints: string[] = []
  for (const [label, owner] of owners) {
    if (!owner) continue
    for (const key of Object.keys(owner)) {
      if (/placement|spawn|position|cells/i.test(key)) hints.push(`${label}.${key}`)
    }
  }

  return { cells: [], source: 'nothing', hints: hints.slice(0, 12) }
}
