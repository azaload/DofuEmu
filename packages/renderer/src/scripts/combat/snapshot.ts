import type { CombatElement } from '@dofemu/shared'
import type { DofusWindow } from '@/types/dofus-window'
import { readBattlefield, holdersOf, type Battlefield, type Combatant } from './battlefield'
import { readSpellbook, type Spellbook } from './spellbook'
import { aimCandidates, effectiveRange, type AimContext } from './aiming'
import {
  distanceToEnemies,
  scoreCast,
  threatCount,
  type PlanState,
  type ScoreContext,
  type ScoredCast
} from './evaluate'
import { areCellsAligned, cellCoordinates, cellDistance } from './geometry'
import type { FightChallenge } from '../fight-state'
import type { SpellDetails } from '../spell-catalogue'

/**
 * The fight, written out for a model to read.
 *
 * A one- or two-billion-parameter model cannot work out geometry: ask it
 * which cell an area spell should land on and it will invent one. So nothing
 * is left for it to work out. Every legal cast is computed here, with what it
 * would hit and what it would kill, every legal move with what it opens up,
 * and each one is given a short key. The model picks keys.
 *
 * That is the whole design, and it is why the same snapshot doubles as the
 * explanation of a turn: what the model chose from is exactly what the rules
 * would have chosen from.
 */

export interface SnapshotFighter {
  /** Short number the model is asked to use: 1, 2, 3. */
  n: number
  id: number
  name: string
  cell: number
  x: number
  y: number
  hp: number
  maxHp: number
  /** Life left as a percentage, so "nearly dead" is obvious. */
  hpPercent: number
  distance: number
  los: boolean
  aligned: boolean
  /** Cells it can cover on its own next turn, movement plus its reach. */
  reach: number
  /** It is standing next to us: leaving is tackled. */
  inContact: boolean
  /** Percentage resistance per element, only the ones that are not zero. */
  resists: Partial<Record<CombatElement, number>>
}

export interface SnapshotSpell {
  id: number
  name: string
  ap: number
  range: string
  area: string
  line: boolean
  los: boolean
  elements: CombatElement[]
  /** "ready", or the turns left to wait. */
  cooldown: string
  castsLeft: number | null
  /** Damage it would really take off each enemy, by short number. */
  damage: Record<number, number>
  /** A mastery: put it back up whenever the points allow. */
  mastery: boolean
  /** Why it cannot be cast this turn, when it cannot. */
  blocked: string | null
}

export interface SnapshotCast {
  /** The key the model answers with. */
  k: string
  spell: number
  name: string
  cell: number
  ap: number
  /** Enemies the area covers, by short number. */
  hits: number[]
  /** Allies or ourselves caught in it. */
  friendly: number[]
  damage: number
  kills: number[]
  value: number
}

export interface SnapshotMove {
  k: string
  cell: number
  mp: number
  /** Distance to the closest monster from there. */
  distance: number
  /** Monsters that could reach that cell on their next turn. */
  threats: number
  sees: number
  /** The casts that become possible from there. */
  casts: SnapshotCast[]
}

export interface CombatSnapshot {
  turn: number
  me: {
    id: number
    name: string
    cell: number
    x: number
    y: number
    hp: number
    maxHp: number
    ap: number
    mp: number
    /** Portée: the range it adds to every boostable spell. */
    portee: number
    heldBy: number[]
    canMove: boolean
  }
  enemies: SnapshotFighter[]
  allies: SnapshotFighter[]
  spells: SnapshotSpell[]
  /** Every legal cast from where the character stands. */
  casts: SnapshotCast[]
  /** Every move worth making, with the casts it unlocks. */
  moves: SnapshotMove[]
  challenges: Array<{ name: string; description: string | null }>
  /** One line each on what the fight looks like, for the model to lean on. */
  notes: string[]
}

export interface SnapshotOptions {
  turn: number
  elements: CombatElement[]
  lastCastTurn: ReadonlyMap<number, number>
  castsThisTurn?: ReadonlyMap<number, number>
  actionPoints: number
  movementPoints: number
  canMove: boolean
  ignoreFighters?: ReadonlySet<number>
  challenges?: FightChallenge[]
  /**
   * Offer these spells instead of the whole spellbook — the manual combo,
   * when that is what the turn is meant to play.
   */
  catalogue?: SpellDetails[]
  /** Casts listed per position. More than this only makes the prompt longer. */
  maxCasts?: number
  /** Positions offered. */
  maxMoves?: number
}

const MAX_CASTS = 10
const MAX_MOVES = 8
const MAX_CASTS_PER_MOVE = 3

function describeFighter(
  field: Battlefield,
  fighter: Combatant,
  index: number,
  from: number
): SnapshotFighter {
  const point = cellCoordinates(fighter.cellId)
  const resists: Partial<Record<CombatElement, number>> = {}
  for (const element of ['earth', 'fire', 'water', 'air', 'neutral'] as CombatElement[]) {
    const percent = Math.round(fighter.resistances.percent[element])
    if (percent !== 0) resists[element] = percent
  }

  return {
    n: index + 1,
    id: fighter.id,
    name: fighter.name,
    cell: fighter.cellId,
    x: point.x,
    y: point.y,
    hp: Math.round(fighter.life),
    maxHp: Math.round(fighter.maxLife),
    hpPercent: Math.round(fighter.health * 100),
    distance: cellDistance(from, fighter.cellId),
    los: field.grid.sees(from, fighter.cellId),
    aligned: areCellsAligned(from, fighter.cellId),
    reach: fighter.threatRange,
    inContact: cellDistance(from, fighter.cellId) === 1,
    resists
  }
}

function areaOf(size: number, shape: string): string {
  return size > 0 ? `${shape}/${size}` : 'single cell'
}

function describeSpell(
  book: Spellbook,
  field: Battlefield,
  state: PlanState,
  context: ScoreContext,
  numbers: Map<number, number>
): SnapshotSpell[] {
  return book.states.map((entry) => {
    const spell = entry.spell
    const damage: Record<number, number> = {}

    if (spell.kind === 'damage') {
      for (const enemy of state.enemies) {
        const scored = scoreCast(
          {
            spell,
            from: field.me.cellId,
            cellId: enemy.cellId,
            covered: [enemy.cellId],
            enemies: [enemy],
            friends: [],
            hitsSelf: false
          },
          entry.apCost,
          { ...state, actionPoints: Math.max(state.actionPoints, entry.apCost) },
          context
        )
        const dealt = scored?.damage.get(enemy.id) ?? 0
        if (dealt > 0) damage[numbers.get(enemy.id) ?? enemy.id] = Math.round(dealt)
      }
    }

    return {
      id: spell.id,
      name: spell.name ?? `spell ${spell.id}`,
      ap: entry.apCost,
      range: `${spell.minRange}-${effectiveRange(spell, state.rangeBonus)}`,
      area: areaOf(spell.zone.size, spell.zone.shape),
      line: spell.castInLine,
      los: spell.needsLineOfSight,
      elements: spell.elements,
      cooldown: entry.cooldownLeft > 0 ? `${entry.cooldownLeft} turn(s)` : 'ready',
      castsLeft: entry.castsLeft,
      damage,
      mastery: spell.isMastery,
      blocked: entry.usable ? null : entry.reason
    }
  })
}

/** Every legal cast from one cell, best first, with a key the model can name. */
function castsFrom(
  field: Battlefield,
  book: Spellbook,
  state: PlanState,
  context: ScoreContext,
  from: number,
  numbers: Map<number, number>,
  prefix: string,
  limit: number
): SnapshotCast[] {
  const aim: AimContext = {
    grid: field.grid,
    rangeBonus: state.rangeBonus,
    occupied: state.occupied,
    enemies: state.enemies,
    friends: state.friends
  }

  const scored: ScoredCast[] = []
  for (const entry of book.usable) {
    const spell = entry.spell
    const against =
      spell.kind === 'heal'
        ? state.friends.filter((friend) => friend.life < friend.maxLife)
        : spell.kind === 'boost'
          ? state.friends.filter((friend) => friend.cellId === from)
          : state.enemies

    for (const candidate of aimCandidates(aim, spell, from, against, 3)) {
      const cast = scoreCast(candidate, entry.apCost, state, context)
      if (cast) scored.push(cast)
    }
  }

  scored.sort((a, b) => b.value - a.value)

  const seen = new Set<string>()
  const casts: SnapshotCast[] = []
  for (const cast of scored) {
    const key = `${cast.spell.id}:${cast.candidate.cellId}`
    if (seen.has(key)) continue
    seen.add(key)

    casts.push({
      k: `${prefix}${casts.length + 1}`,
      spell: cast.spell.id,
      name: cast.spell.name ?? `spell ${cast.spell.id}`,
      cell: cast.candidate.cellId,
      ap: cast.apCost,
      hits: cast.candidate.enemies.map((enemy) => numbers.get(enemy.id) ?? enemy.id),
      friendly: cast.candidate.friends.map((friend) => friend.id),
      damage: Math.round([...cast.damage.values()].reduce((total, value) => total + value, 0)),
      kills: cast.kills.map((id) => numbers.get(id) ?? id),
      value: Math.round(cast.value)
    })
    if (casts.length >= limit) break
  }

  return casts
}

export function buildSnapshot(
  gameWindow: DofusWindow,
  options: SnapshotOptions
): CombatSnapshot | null {
  const field = readBattlefield(gameWindow, { turn: options.turn, ignore: options.ignoreFighters })
  if (!field) return null

  const book = readSpellbook(gameWindow, {
    turn: options.turn,
    elements: options.elements,
    lastCastTurn: options.lastCastTurn,
    castsThisTurn: options.castsThisTurn,
    actionPoints: options.actionPoints,
    catalogue: options.catalogue
  })

  const from = field.me.cellId
  const numbers = new Map(field.enemies.map((enemy, index) => [enemy.id, index + 1]))
  const friends = [field.me, ...field.allies]

  const state: PlanState = {
    actionPoints: options.actionPoints,
    movementPoints: options.canMove ? options.movementPoints : 0,
    enemies: field.enemies.map((enemy) => ({ ...enemy })),
    friends: friends.map((friend) => ({ ...friend })),
    occupied: new Set(field.occupied),
    castsThisTurn: new Map(options.castsThisTurn ?? []),
    castsPerTarget: new Map(),
    rangeBonus: 0,
    powerBonus: 0,
    buffsUp: new Set()
  }

  const context: ScoreContext = {
    profile: field.profile,
    grid: field.grid,
    fightEndsThisTurn: false,
    cheapestAttack: book.cheapestAttack
  }

  const casts = castsFrom(
    field,
    book,
    state,
    context,
    from,
    numbers,
    'c',
    options.maxCasts ?? MAX_CASTS
  )

  const moves: SnapshotMove[] = []
  if (state.movementPoints > 0 && holdersOf(field, from).length === 0) {
    const blocked = new Set([...state.occupied].filter((cellId) => cellId !== from))
    const reachable = [...field.grid.reachable(from, state.movementPoints, blocked).values()]
      .filter((entry) => entry.cellId !== from && !state.occupied.has(entry.cellId))
      .map((entry) => ({
        entry,
        distance: distanceToEnemies(entry.cellId, state.enemies),
        threats: threatCount(entry.cellId, state.enemies),
        sees: state.enemies.filter((enemy) => field.grid.sees(entry.cellId, enemy.cellId)).length
      }))

    // The cells a ranged character would look at: somewhere it can see from,
    // out of the pack's reach, as far back as that allows.
    reachable.sort((a, b) => {
      if (a.sees !== b.sees) return b.sees - a.sees
      if (a.threats !== b.threats) return a.threats - b.threats
      if (a.distance !== b.distance) return b.distance - a.distance
      return a.entry.cost - b.entry.cost
    })

    for (const option of reachable.slice(0, options.maxMoves ?? MAX_MOVES)) {
      const key = `m${moves.length + 1}`
      const there: PlanState = { ...state, occupied: new Set(state.occupied) }
      there.occupied.delete(from)
      there.occupied.add(option.entry.cellId)
      there.friends = state.friends.map((friend) =>
        friend.side === 'me' ? { ...friend, cellId: option.entry.cellId } : friend
      )

      moves.push({
        k: key,
        cell: option.entry.cellId,
        mp: option.entry.cost,
        distance: option.distance,
        threats: option.threats,
        sees: option.sees,
        casts: castsFrom(
          field,
          book,
          there,
          context,
          option.entry.cellId,
          numbers,
          `${key}c`,
          MAX_CASTS_PER_MOVE
        )
      })
    }
  }

  const holders = holdersOf(field, from)
  const notes: string[] = []
  if (holders.length > 0) {
    notes.push(
      `${holders.length} monster(s) hold the character in contact: moving is tackled, so cast from here`
    )
  }
  if (casts.length === 0 && moves.every((move) => move.casts.length === 0)) {
    notes.push('nothing can be cast from anywhere in reach this turn: walk towards the pack')
  }
  const mastery = book.masteries[0]
  if (mastery) {
    notes.push(
      `${mastery.spell.name ?? mastery.spell.id} is a mastery and is ready: cast it first when the points left still buy an attack`
    )
  }

  return {
    turn: options.turn,
    me: {
      id: field.me.id,
      name: field.me.name,
      cell: from,
      x: cellCoordinates(from).x,
      y: cellCoordinates(from).y,
      hp: Math.round(field.me.life),
      maxHp: Math.round(field.me.maxLife),
      ap: options.actionPoints,
      mp: state.movementPoints,
      portee: field.rangeBonus,
      heldBy: holders.map((enemy) => numbers.get(enemy.id) ?? enemy.id),
      canMove: options.canMove && holders.length === 0 && state.movementPoints > 0
    },
    enemies: field.enemies.map((enemy, index) => describeFighter(field, enemy, index, from)),
    allies: field.allies.map((ally, index) => describeFighter(field, ally, index, from)),
    spells: describeSpell(book, field, state, context, numbers),
    casts,
    moves,
    challenges: (options.challenges ?? []).map((challenge) => ({
      name: challenge.name ?? `#${challenge.id}`,
      description: challenge.description
    })),
    notes
  }
}
