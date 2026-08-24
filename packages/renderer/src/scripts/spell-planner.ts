import type { CombatElement } from '@dofemu/shared'
import type { DofusWindow } from '@/types/dofus-window'
import {
  areCellsAligned,
  cellCoordinates,
  cellDistance,
  hasLineOfSight,
  isCellWalkable,
  reachableCells,
  CELL_COUNT
} from './cells'
import { getAllies, getEnemies, getFighters, getMyFighter, type Fighter } from './fight-bridge'
import { damageAgainst, readDamageProfile, type DamageProfile } from './damage'
import { readSpellCatalogue, type SpellDetails } from './spell-catalogue'
import { areaCells } from './zones'

/**
 * Decides the whole turn: where to stand, and what to cast from there.
 *
 * A cast is aimed at a cell, never at a fighter, which is what lets an area
 * spell catch several monsters at once or reach one it may not target
 * directly. Positions and casts are weighed together, since a step sideways
 * often unlocks a far better cast than the best one available where the
 * character stands.
 */

export interface PlannedCast {
  spellId: number
  name: string | null
  cellId: number
  /** Fighter ids the area lands on. */
  hits: number[]
  /** Allies, or ourselves, caught in the same area. */
  friendlyHits: number[]
  apCost: number
  value: number
  reason: string
}

export interface PlannedMove {
  type: 'move'
  cellId: number
  path: number[]
  cost: number
  reason: string
}

export interface PlannedSpell extends PlannedCast {
  type: 'cast'
}

export type PlannedAction = PlannedMove | PlannedSpell

export interface TurnPlan {
  /** Moves and casts, in the order they should be played. */
  actions: PlannedAction[]
  casts: PlannedCast[]
  value: number
  /** Why the plan is empty, when it is. Never a silent nothing. */
  diagnostic: string | null
}

export interface PlanContext {
  turn: number
  actionPoints: number
  movementPoints: number
  elements: CombatElement[]
  /** Spell id to the turn it was last cast on. */
  lastCastTurn: Map<number, number>
  /** Moving is off the table: held in contact, or a challenge forbids it. */
  canMove: boolean
  /** Prefer standing away from the enemies once the casting is decided. */
  keepDistance: boolean
}

/** What one point of damage is worth against everything else. */
const KILL_BONUS = 400
const ALLY_PENALTY = 3
const SELF_PENALTY = 6
const BUFF_VALUE = 120
const HEAL_VALUE = 2
const MOVE_COST_PENALTY = 0.5
const DISTANCE_BONUS = 4
/** Casts examined per position; more than this buys nothing in practice. */
const MAX_CASTS_PER_TURN = 6

interface SimState {
  /** The character's own damage statistics, read once per plan. */
  profile: DamageProfile
  actionPoints: number
  /** Life we expect each enemy to have left, so a target is not overkilled. */
  life: Map<number, number>
  castsThisTurn: Map<number, number>
  castsPerTarget: Map<string, number>
  /** Enemies already touched this turn, for a single-target challenge. */
  hitThisTurn: Set<number>
  /** Everything alive is expected to die this turn: a boost would be wasted. */
  fightEndsThisTurn: boolean
  /** Cheapest attack available, so a buff never eats the points to hit with. */
  cheapestAttackCost: number
}

function elementAllowed(spell: SpellDetails, allowed: CombatElement[]): boolean {
  // A spell whose element the client does not expose is never filtered out.
  if (spell.elements.length === 0) return true
  if (allowed.length === 0) return true
  return spell.elements.some((element) => allowed.includes(element))
}

function offCooldown(spell: SpellDetails, context: PlanContext): boolean {
  const last = context.lastCastTurn.get(spell.id)
  if (last === undefined) return true
  return context.turn - last > spell.cooldown
}

function castsLeft(spell: SpellDetails, state: SimState): boolean {
  const already = state.castsThisTurn.get(spell.id) ?? 0
  return already < (spell.maxCastsPerTurn ?? Number.MAX_SAFE_INTEGER)
}

function targetCastsLeft(spell: SpellDetails, state: SimState, fighterId: number): boolean {
  const key = `${spell.id}:${fighterId}`
  const already = state.castsPerTarget.get(key) ?? 0
  return already < (spell.maxCastsPerTarget ?? Number.MAX_SAFE_INTEGER)
}

/** Cells a spell may legally be aimed at, from `from`. */
export function castableCells(
  gameWindow: DofusWindow,
  spell: SpellDetails,
  from: number,
  occupied: Set<number>
): number[] {
  const cells: number[] = []
  const origin = cellCoordinates(from)

  for (let cellId = 0; cellId < CELL_COUNT; cellId++) {
    const distance = cellDistance(from, cellId)
    if (distance > spell.range || distance < spell.minRange) continue

    if (spell.castInLine && !areCellsAligned(from, cellId)) continue
    if (spell.castInDiagonal) {
      const point = cellCoordinates(cellId)
      if (Math.abs(point.x - origin.x) !== Math.abs(point.y - origin.y)) continue
    }

    if (spell.needsFreeCell && occupied.has(cellId)) continue
    if (spell.needsTakenCell && !occupied.has(cellId)) continue
    if (!spell.needsTakenCell && !isCellWalkable(gameWindow, cellId) && !occupied.has(cellId)) {
      // An obstacle can still be aimed at by an area spell, but never by a
      // spell that must land on someone.
      if (spell.zone.size === 0) continue
    }

    if (spell.needsLineOfSight && !hasLineOfSight(gameWindow, from, cellId)) continue

    cells.push(cellId)
  }

  return cells
}

/** Fighters an area lands on when the spell is aimed at `cellId` from `from`. */
export function hitsFrom(
  spell: SpellDetails,
  from: number,
  cellId: number,
  fighters: Fighter[]
): Fighter[] {
  const covered = areaCells(spell.zone, from, cellId)
  return fighters.filter((fighter) => fighter.cellId !== null && covered.includes(fighter.cellId))
}

/**
 * What a cast is worth from `from`, or null when it is not worth casting.
 *
 * Damage counts only up to what the target has left, so two spells are never
 * both spent on a monster one would already kill; allies and the caster in the
 * area cost more than they bring.
 */
function valueOfCast(
  gameWindow: DofusWindow,
  spell: SpellDetails,
  from: number,
  cellId: number,
  enemies: Fighter[],
  friends: Fighter[],
  state: SimState,
  context: PlanContext
): PlannedCast | null {
  const apCost = spell.apCost ?? 0
  if (apCost > state.actionPoints) return null

  const hits = hitsFrom(spell, from, cellId, enemies)
  const friendlyHits = hitsFrom(spell, from, cellId, friends)

  if (spell.kind === 'damage') {
    if (hits.length === 0) return null
    if (!hits.some((enemy) => targetCastsLeft(spell, state, enemy.id))) return null

    // A monster the plan has already killed is worth nothing more: counting it
    // again would spend a second spell on a corpse.
    const alive = hits.filter((enemy) => (state.life.get(enemy.id) ?? enemy.life ?? 1) > 0)
    if (alive.length === 0) return null

    let value = 0
    for (const enemy of alive) {
      // What this spell really takes off this monster, statistics and its own
      // resistances included: the best spell is not the same on every target.
      const dealt = damageAgainst(spell, enemy, state.profile)
      const left = state.life.get(enemy.id) ?? enemy.life ?? dealt
      value += Math.min(dealt, left)
      if (dealt >= left) value += KILL_BONUS
    }

    const friendlyCost = friendlyHits.reduce(
      (total, friend) => total + damageAgainst(spell, friend, state.profile),
      0
    )
    value -= friendlyCost * ALLY_PENALTY
    if (friendlyHits.some((friend) => friend.cellId === from)) {
      value -= damageAgainst(spell, friendlyHits[0], state.profile) * SELF_PENALTY
    }

    if (value <= 0) return null

    return {
      spellId: spell.id,
      name: spell.name,
      cellId,
      hits: alive.map((enemy) => enemy.id),
      friendlyHits: friendlyHits.map((friend) => friend.id),
      apCost,
      value,
      reason:
        alive.length > 1
          ? `${alive.length} enemies in the area`
          : (alive[0].name ?? `fighter ${alive[0].id}`)
    }
  }

  if (spell.kind === 'heal') {
    const wounded = friendlyHits.filter(
      (friend) => friend.life !== null && friend.maxLife !== null && friend.life < friend.maxLife
    )
    if (wounded.length === 0) return null

    const value = wounded.reduce((total, friend) => {
      const missing = (friend.maxLife ?? 0) - (friend.life ?? 0)
      return total + Math.min(spell.heal, missing) * HEAL_VALUE
    }, 0)

    return {
      spellId: spell.id,
      name: spell.name,
      cellId,
      hits: [],
      friendlyHits: wounded.map((friend) => friend.id),
      apCost,
      value,
      reason: `healing ${wounded.length}`
    }
  }

  // Boosts, summons and the rest: worth casting on ourselves once they are off
  // cooldown, and worth more than a small hit since they last the fight —
  // unless the fight is about to end, where the points buy damage instead.
  if (cellId !== from) return null
  if (spell.kind === 'boost') {
    // A buff already up this turn gains nothing from being cast again.
    if ((state.castsThisTurn.get(spell.id) ?? 0) > 0) return null
    if (state.fightEndsThisTurn) return null
    // And it must never eat the points the turn needs to actually hit.
    if (state.actionPoints - apCost < state.cheapestAttackCost) return null
  }
  return {
    spellId: spell.id,
    name: spell.name,
    cellId: from,
    hits: [],
    friendlyHits: [],
    apCost,
    value: BUFF_VALUE - apCost,
    reason: spell.kind === 'boost' ? 'keeping the boost up' : spell.kind
  }
}

/** The best single cast from a position, given the state so far. */
function bestCastFrom(
  gameWindow: DofusWindow,
  from: number,
  spells: SpellDetails[],
  enemies: Fighter[],
  friends: Fighter[],
  occupied: Set<number>,
  state: SimState,
  context: PlanContext
): PlannedCast | null {
  const usable = spells.filter(
    (spell) => castsLeft(spell, state) && (spell.apCost ?? 0) <= state.actionPoints
  )

  // A boost lasts several turns, so it is worth more than any single hit — as
  // long as enough action points are left afterwards to still attack. Scoring
  // it against one cast would always lose to a big damage spell.
  for (const spell of usable) {
    if (spell.kind !== 'boost') continue
    const candidate = valueOfCast(gameWindow, spell, from, from, enemies, friends, state, context)
    if (candidate) return candidate
  }

  let best: PlannedCast | null = null

  for (const spell of usable) {
    for (const cellId of castableCells(gameWindow, spell, from, occupied)) {
      const candidate = valueOfCast(gameWindow, spell, from, cellId, enemies, friends, state, context)
      if (!candidate) continue
      if (!best || candidate.value > best.value) best = candidate
    }
  }

  return best
}

/**
 * The turn, as a sequence of moves and casts.
 *
 * At every step the character either casts the best spell available where it
 * stands, or walks to a cell that unlocks a better one — so the movement
 * points can be spent at the start of the turn, between two casts, or not at
 * all, whichever is worth the most. Walking is charged a little, so a move has
 * to earn its points.
 */
export function planTurn(gameWindow: DofusWindow, context: PlanContext): TurnPlan | null {
  const me = getMyFighter(gameWindow)
  if (!me || me.cellId === null) return null

  const enemies = getEnemies(gameWindow).filter((enemy) => enemy.cellId !== null)
  const allies = getAllies(gameWindow)
  const friends = [me, ...allies]

  const empty = (diagnostic: string): TurnPlan => ({
    actions: [],
    casts: [],
    value: 0,
    diagnostic
  })

  const catalogue = readSpellCatalogue(gameWindow)
  if (catalogue.length === 0) {
    return empty('the spellbook could not be read from this client')
  }

  const allowed = catalogue.filter((spell) => elementAllowed(spell, context.elements))
  if (allowed.length === 0) {
    return empty(
      `every spell is filtered out by the chosen elements (${context.elements.join(', ') || 'none'})`
    )
  }

  const spells = allowed.filter((spell) => offCooldown(spell, context))
  if (spells.length === 0) return empty('every spell is still on cooldown')

  const affordable = spells.filter((spell) => (spell.apCost ?? 0) <= context.actionPoints)
  if (affordable.length === 0) {
    return empty(`no spell costs ${context.actionPoints} action point(s) or less`)
  }

  if (enemies.length === 0) return empty('no enemy left to aim at')

  const occupied = new Set(
    getFighters(gameWindow)
      .filter((fighter) => fighter.alive && fighter.cellId !== null)
      .map((fighter) => fighter.cellId as number)
  )

  // Damage we could put out this turn against what everything has left: a
  // boost is wasted when the fight is already over.
  const totalLife = enemies.reduce((total, enemy) => total + (enemy.life ?? 0), 0)
  const bestDamage = Math.max(
    ...affordable.map((spell) =>
      Math.max(...enemies.map((enemy) => damageAgainst(spell, enemy, readDamageProfile(gameWindow))), 0)
    ),
    0
  )
  const castsAfforded = Math.floor(
    context.actionPoints / Math.max(1, Math.min(...affordable.map((spell) => spell.apCost ?? 1)))
  )

  const profile = readDamageProfile(gameWindow)

  const state: SimState = {
    profile,
    actionPoints: context.actionPoints,
    life: new Map(enemies.map((enemy) => [enemy.id, enemy.life ?? 0])),
    castsThisTurn: new Map(),
    castsPerTarget: new Map(),
    hitThisTurn: new Set(),
    fightEndsThisTurn: totalLife > 0 && bestDamage * castsAfforded >= totalLife,
    cheapestAttackCost: Math.min(
      ...affordable.filter((spell) => spell.kind === 'damage').map((spell) => spell.apCost ?? 0),
      Number.MAX_SAFE_INTEGER
    )
  }

  const actions: PlannedAction[] = []
  const casts: PlannedCast[] = []
  let position = me.cellId
  let movementPoints = context.canMove ? context.movementPoints : 0
  let total = 0

  const distanceToEnemies = (cellId: number) =>
    enemies.reduce(
      (closest, enemy) => Math.min(closest, cellDistance(cellId, enemy.cellId as number)),
      Number.MAX_SAFE_INTEGER
    )

  const safetyOf = (cellId: number) => {
    if (!context.keepDistance) return 0
    const distance = distanceToEnemies(cellId)
    return distance === Number.MAX_SAFE_INTEGER ? 0 : distance * DISTANCE_BONUS
  }

  for (let step = 0; step < MAX_CASTS_PER_TURN * 2; step++) {
    const occupiedHere = new Set(occupied)
    occupiedHere.delete(me.cellId)
    occupiedHere.add(position)

    const here = bestCastFrom(gameWindow, position, spells, enemies, friends, occupiedHere, state, context)

    // What a step sideways would buy, casts and safety together.
    let move: { cellId: number; path: number[]; cost: number; gain: number; cast: PlannedCast | null } | null = null

    if (movementPoints > 0) {
      const blocked = new Set([...occupied].filter((cellId) => cellId !== position))
      const currentValue = (here?.value ?? 0) + safetyOf(position)

      for (const entry of reachableCells(gameWindow, position, movementPoints, blocked).values()) {
        if (entry.cellId === position) continue

        const occupiedThere = new Set(occupied)
        occupiedThere.delete(me.cellId)
        occupiedThere.add(entry.cellId)

        const cast = bestCastFrom(gameWindow, entry.cellId, spells, enemies, friends, occupiedThere, state, context)
        const gain =
          (cast?.value ?? 0) + safetyOf(entry.cellId) - currentValue - entry.cost * MOVE_COST_PENALTY

        if (gain > 0 && (!move || gain > move.gain)) {
          move = { cellId: entry.cellId, path: entry.path, cost: entry.cost, gain, cast }
        }
      }
    }

    if (move) {
      actions.push({
        type: 'move',
        cellId: move.cellId,
        path: move.path,
        cost: move.cost,
        reason: move.cast
          ? `to cast ${move.cast.name ?? move.cast.spellId} on ${move.cast.reason}`
          : `${distanceToEnemies(move.cellId)} cell(s) from the closest enemy`
      })
      position = move.cellId
      movementPoints -= move.cost
      total += move.gain
      continue
    }

    if (!here) break

    actions.push({ type: 'cast', ...here })
    casts.push(here)
    total += here.value
    state.actionPoints -= here.apCost
    state.castsThisTurn.set(here.spellId, (state.castsThisTurn.get(here.spellId) ?? 0) + 1)

    const spell = spells.find((candidate) => candidate.id === here.spellId)
    for (const hit of here.hits) {
      const key = `${here.spellId}:${hit}`
      state.castsPerTarget.set(key, (state.castsPerTarget.get(key) ?? 0) + 1)
      const enemy = enemies.find((candidate) => candidate.id === hit)
      const dealt = spell && enemy ? damageAgainst(spell, enemy, state.profile) : (spell?.damage ?? 0)
      state.life.set(hit, Math.max(0, (state.life.get(hit) ?? 0) - dealt))
      state.hitThisTurn.add(hit)
    }

    if (state.actionPoints <= 0) break
  }

  return {
    actions,
    casts,
    value: total,
    diagnostic:
      actions.length === 0
        ? 'no cell brings an enemy within reach of a spell that is worth casting'
        : null
  }
}
