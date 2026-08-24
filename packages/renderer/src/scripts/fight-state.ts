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
  /** Short number the model is asked to use, 1, 2, 3... */
  n: number
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
  /** Enemies this spell can hit right now, by their short number. */
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
  /** What the game says the challenge asks for, when it is on screen. */
  description: string | null
  /** Fighter the challenge points at, when it names one. */
  targetId: number | null
}

/**
 * What a challenge forbids, read from its wording.
 *
 * Only rules that can be enforced without guessing are derived; everything
 * else is left to the model, which gets the full text.
 */
export interface ChallengeRules {
  /** Moving at all breaks a challenge. */
  noMove: boolean
  /** Only one enemy may be hit this turn. */
  singleTarget: boolean
  /** Ending the turn next to an enemy breaks a challenge. */
  avoidMelee: boolean
  /** The fighter a challenge points at, when one does. */
  focusTargetId: number | null
}

const NO_MOVE = /(ne pas (se )?d[ée]placer|sans (se )?d[ée]placer|statique|immobile|do not move|no move|stand still)/i
const SINGLE_TARGET = /(un seul (ennemi|adversaire|monstre)|une seule cible|single target|only one (enemy|target)|focus)/i
const NO_MELEE = /(corps [àa] corps|au contact|melee|adjacent)/i

export function deriveChallengeRules(challenges: FightChallenge[]): ChallengeRules {
  const text = challenges
    .map((challenge) => `${challenge.name ?? ''} ${challenge.description ?? ''}`)
    .join(' ')

  return {
    noMove: NO_MOVE.test(text),
    singleTarget: SINGLE_TARGET.test(text),
    avoidMelee: NO_MELEE.test(text),
    focusTargetId: challenges.find((challenge) => challenge.targetId !== null)?.targetId ?? null
  }
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
  /** Constraints read from the challenges, already applied to what is offered. */
  challengeRules: ChallengeRules
}

const MAX_CELLS = 12

function describe(
  gameWindow: DofusWindow,
  from: number | null,
  fighter: Fighter,
  index: number
): StateFighter {
  const point = fighter.cellId !== null ? cellCoordinates(fighter.cellId) : null
  return {
    n: index + 1,
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
  options: {
    turn: number
    combo: CombatSpell[]
    fallbackRange: number
    tackleAware?: boolean
    /** Challenges captured from the fight messages, when the caller has them. */
    challenges?: FightChallenge[]
  }
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
          .map((enemy) => enemies.indexOf(enemy) + 1)

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
  const challenges = options.challenges ?? readChallenges(gameWindow)
  const rules = deriveChallengeRules(challenges)

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
    enemies: enemies.map((enemy, index) => describe(gameWindow, from, enemy, index)),
    allies: allies.map((ally, index) => describe(gameWindow, from, ally, index)),
    cells,
    challenges,
    challengeRules: rules
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
          description:
            typeof dict.description === 'string'
              ? dict.description
              : typeof dict.desc === 'string'
                ? dict.desc
                : null,
          targetId: typeof dict.targetId === 'number' ? dict.targetId : null
        }
      })
      .filter((challenge): challenge is FightChallenge => challenge !== null)

    if (challenges.length > 0) return challenges
  }

  return []
}

/**
 * Challenge names and wording as the game shows them.
 *
 * The protocol carries ids only, so the text comes from the panel on screen —
 * that is what tells a model what a challenge actually asks for.
 */
export function readChallengeTexts(gameWindow: DofusWindow): Array<{ name: string; description: string | null }> {
  const found: Array<{ name: string; description: string | null }> = []

  try {
    for (const element of gameWindow.document.querySelectorAll('.challenge, .challengeSlot, .challengeIcon, [class*="hallenge"]')) {
      const host = element as HTMLElement
      if (host.offsetParent === null) continue

      const name = (host.querySelector('.title, .name, .challengeName') as HTMLElement | null)?.innerText
      const description = (host.querySelector('.description, .desc, .challengeDescription') as HTMLElement | null)?.innerText
      const whole = host.innerText ?? host.textContent ?? ''

      const label = (name ?? whole).trim().slice(0, 60)
      if (label.length === 0) continue
      if (found.some((entry) => entry.name === label)) continue
      // The panel's own heading is not a challenge.
      if (/^(challenges?|defis?|défis?)$/i.test(label)) continue

      found.push({
        name: label,
        description: (description ?? (name ? whole : null))?.trim().slice(0, 200) ?? null
      })
    }
  } catch {}

  return found
}
