import type { SpellDetails } from '../spell-catalogue'
import { damageWith, type DamageProfile } from '../damage'
import type { Combatant } from './battlefield'
import type { AimCandidate } from './aiming'
import { cellCoordinates, cellDistance, cellFromCoordinates, type Grid } from './geometry'

/**
 * What a cast is worth, and what the fight looks like once it has landed.
 *
 * Nothing here talks to the game. A plan is a chain of these: score a cast on
 * the state it would be thrown into, apply it, score the next one on what is
 * left. A monster killed by the first cast is gone for the second, one pushed
 * by it stands somewhere else, and a mastery put up by it makes everything
 * after it hit harder.
 */

/** What one point of damage is worth against everything else. */
export const KILL_BONUS = 400
/**
 * How much finishing a wounded monster is worth beyond the damage itself.
 *
 * Spreading damage evenly leaves every monster alive and hitting back. The
 * one closest to death is the one worth another arrow: a dead monster stops
 * playing altogether, which is the cheapest defence there is.
 */
export const FOCUS_BONUS = 40
/**
 * What each extra monster caught in the same area is worth.
 *
 * The damage is already counted per monster, so this only settles ties — but
 * it settles them the right way: two monsters for one cast is the shape a
 * turn should have, even when the second one takes a glancing hit.
 */
export const MULTI_HIT_BONUS = 25
export const ALLY_PENALTY = 3
export const SELF_PENALTY = 6
/**
 * What catching a friend in the area costs on top of the damage itself.
 *
 * The damage alone does not say enough: a spell that grazes an ally for ten
 * points to reach a second monster would otherwise look like a bargain. It is
 * not — the cast that only hits monsters is nearly always available, and it
 * must win whenever it is.
 */
export const FRIENDLY_FIRE = 50
export const SELF_FIRE = 120
export const BUFF_VALUE = 120
export const HEAL_VALUE = 2

export interface PlanState {
  actionPoints: number
  movementPoints: number
  /** Enemies still standing, with the life and the cells the plan believes. */
  enemies: Combatant[]
  /** Ourselves and the allies. The caster is always the first entry. */
  friends: Combatant[]
  /** Every cell a fighter stands on, kept in step with the pushes. */
  occupied: Set<number>
  castsThisTurn: Map<number, number>
  castsPerTarget: Map<string, number>
  /** Range a buff cast this turn has granted. */
  rangeBonus: number
  /** Damage percentage a mastery cast this turn has granted. */
  powerBonus: number
  /** Masteries already put up this turn: casting one twice buys nothing. */
  buffsUp: Set<number>
}

export interface ScoreContext {
  profile: DamageProfile
  grid: Grid
  /** Everything alive is expected to die this turn: a buff would be wasted. */
  fightEndsThisTurn: boolean
  /** The cheapest attack available, so a buff never eats the points to hit with. */
  cheapestAttack: number
}

export interface ScoredCast {
  candidate: AimCandidate
  spell: SpellDetails
  apCost: number
  value: number
  /** Damage each enemy is expected to take. */
  damage: Map<number, number>
  /** Enemies this cast finishes off. */
  kills: number[]
  reason: string
}

function boostOf(state: PlanState) {
  return { damagePercent: state.powerBonus }
}

/** Whether this spell may still be cast, given what the turn has already done. */
export function castsLeft(spell: SpellDetails, state: PlanState): boolean {
  const already = state.castsThisTurn.get(spell.id) ?? 0
  return already < (spell.maxCastsPerTurn ?? Number.MAX_SAFE_INTEGER)
}

export function targetCastsLeft(spell: SpellDetails, state: PlanState, fighterId: number): boolean {
  const already = state.castsPerTarget.get(`${spell.id}:${fighterId}`) ?? 0
  return already < (spell.maxCastsPerTarget ?? Number.MAX_SAFE_INTEGER)
}

/**
 * What a cast is worth, or null when it is not worth throwing.
 *
 * Damage counts only up to what the target has left, so two spells are never
 * both spent on a monster the first one already kills; allies caught in the
 * area cost several times what they take, and the caster costs more still.
 */
export function scoreCast(
  candidate: AimCandidate,
  apCost: number,
  state: PlanState,
  context: ScoreContext
): ScoredCast | null {
  const spell = candidate.spell
  if (apCost > state.actionPoints) return null

  const damage = new Map<number, number>()
  const kills: number[] = []

  if (spell.kind === 'damage') {
    const reachable = candidate.enemies.filter(
      (enemy) => enemy.life > 0 && targetCastsLeft(spell, state, enemy.id)
    )
    if (reachable.length === 0) return null

    let value = 0
    for (const enemy of reachable) {
      const dealt = damageWith(spell, enemy.resistances, context.profile, boostOf(state))
      damage.set(enemy.id, dealt)
      value += Math.min(dealt, enemy.life)

      if (dealt >= enemy.life) {
        value += KILL_BONUS
        kills.push(enemy.id)
        continue
      }

      // Short of a kill, the closer to death the better: it is the next one
      // to fall, and one fewer monster playing its turn. Clamped, because a
      // client reporting more life than the maximum — a shield, a stale
      // reading — must not turn the bonus into a penalty.
      const full = enemy.maxLife > 0 ? enemy.maxLife : enemy.life
      value += Math.min(1, Math.max(0, 1 - enemy.life / full)) * FOCUS_BONUS
    }

    value += (reachable.length - 1) * MULTI_HIT_BONUS

    for (const friend of candidate.friends) {
      const taken = damageWith(spell, friend.resistances, context.profile, boostOf(state))
      value -= taken * (friend.side === 'me' ? SELF_PENALTY : ALLY_PENALTY)
      value -= friend.side === 'me' ? SELF_FIRE : FRIENDLY_FIRE
    }

    if (value <= 0) return null

    return {
      candidate,
      spell,
      apCost,
      value,
      damage,
      kills,
      reason:
        reachable.length > 1
          ? `${reachable.length} enemies in the area`
          : (reachable[0].name ?? `fighter ${reachable[0].id}`)
    }
  }

  if (spell.kind === 'heal') {
    const wounded = candidate.friends.filter((friend) => friend.life < friend.maxLife)
    if (wounded.length === 0) return null

    const value = wounded.reduce(
      (total, friend) => total + Math.min(spell.heal, friend.maxLife - friend.life) * HEAL_VALUE,
      0
    )
    if (value <= 0) return null

    return {
      candidate,
      spell,
      apCost,
      value,
      damage,
      kills,
      reason: `healing ${wounded.length}`
    }
  }

  // Only a boost this code actually recognises is worth a turn's points.
  // Anything whose effects it cannot read — a state, a trap, a debuff — is
  // left alone rather than played as if it were a buff, which is what had
  // utility arrows cast ahead of the real attacks.
  if (spell.kind !== 'boost') return null
  if (candidate.cellId !== candidate.from) return null
  if (state.buffsUp.has(spell.id) || (state.castsThisTurn.get(spell.id) ?? 0) > 0) return null
  if (context.fightEndsThisTurn) return null

  // The adaptation to the points available, in one line: a mastery is only
  // worth casting when what is left after it still buys an attack.
  const gained = spell.apGain
  if (state.actionPoints - apCost + gained < context.cheapestAttack) return null

  // A buff that lasts is worth more than the one cast it costs, which is the
  // whole reason to open a turn with a mastery rather than an arrow.
  const lasting = 1 + Math.min(4, spell.buffTurns) / 4
  const points = (spell.apGain + spell.mpGain) * 30

  return {
    candidate,
    spell,
    apCost,
    value: BUFF_VALUE * lasting - apCost + points,
    damage,
    kills,
    reason: spell.isMastery ? 'keeping the mastery up' : 'keeping the boost up'
  }
}

/**
 * Where a cast leaves the fighters it touched.
 *
 * A spell that pushes empties the cells it just hit; one that pulls draws
 * everything towards the cell it was aimed at. Planning the next cast on the
 * positions the last one left behind is what sends a second area spell into
 * thin air — and what makes a pull visibly worth casting, since it groups a
 * scattered pack into one area.
 */
function displace(
  grid: Grid,
  spell: SpellDetails,
  candidate: AimCandidate,
  moved: Combatant[],
  occupied: Set<number>
): void {
  const distance = spell.pushDistance > 0 ? spell.pushDistance : spell.pullDistance
  if (distance <= 0) return

  const pushing = spell.pushDistance > 0
  const anchor = cellCoordinates(pushing ? candidate.from : candidate.cellId)
  const touched = new Set(candidate.enemies.map((enemy) => enemy.id))

  for (const fighter of moved) {
    if (!touched.has(fighter.id)) continue

    const here = cellCoordinates(fighter.cellId)
    const dx = here.x - anchor.x
    const dy = here.y - anchor.y
    if (dx === 0 && dy === 0) continue

    // One direction, the dominant one, as the game slides along a line.
    const stepX = Math.abs(dx) >= Math.abs(dy) ? Math.sign(dx) : 0
    const stepY = stepX === 0 ? Math.sign(dy) : 0
    const way = pushing ? 1 : -1

    let cellId = fighter.cellId
    for (let step = 1; step <= distance; step++) {
      const next = cellFromCoordinates(here.x + stepX * way * step, here.y + stepY * way * step)
      // A body or a wall stops the slide, as it does in the game.
      if (next === null || occupied.has(next) || !grid.walkable(next)) break
      occupied.delete(cellId)
      cellId = next
      occupied.add(cellId)
    }

    fighter.cellId = cellId
  }
}

/** The fight as it stands once this cast has been played. */
export function applyCast(
  state: PlanState,
  cast: ScoredCast,
  context: ScoreContext
): PlanState {
  const occupied = new Set(state.occupied)
  const enemies: Combatant[] = []

  for (const enemy of state.enemies) {
    const dealt = cast.damage.get(enemy.id) ?? 0
    const life = enemy.life - dealt
    if (life <= 0) {
      // A corpse leaves its cell: the next cast may stand there, walk through
      // it, or aim past it.
      occupied.delete(enemy.cellId)
      continue
    }
    enemies.push({ ...enemy, life, health: enemy.maxLife > 0 ? life / enemy.maxLife : 1 })
  }

  displace(context.grid, cast.spell, cast.candidate, enemies, occupied)

  const castsThisTurn = new Map(state.castsThisTurn)
  castsThisTurn.set(cast.spell.id, (castsThisTurn.get(cast.spell.id) ?? 0) + 1)

  const castsPerTarget = new Map(state.castsPerTarget)
  for (const enemy of cast.candidate.enemies) {
    const key = `${cast.spell.id}:${enemy.id}`
    castsPerTarget.set(key, (castsPerTarget.get(key) ?? 0) + 1)
  }

  const buffsUp = new Set(state.buffsUp)
  if (cast.spell.kind === 'boost') buffsUp.add(cast.spell.id)

  return {
    ...state,
    // The points a boost hands back are points the rest of the turn can spend.
    actionPoints: state.actionPoints - cast.apCost + cast.spell.apGain,
    movementPoints: state.movementPoints + cast.spell.mpGain,
    enemies,
    occupied,
    castsThisTurn,
    castsPerTarget,
    // A range buff changes what the rest of the turn can reach, which is the
    // whole reason to cast it before attacking rather than after.
    rangeBonus: state.rangeBonus + cast.spell.rangeBoost,
    powerBonus: state.powerBonus + cast.spell.powerBoost,
    buffsUp
  }
}

/** Distance from a cell to the closest enemy the plan still believes alive. */
export function distanceToEnemies(cellId: number, enemies: Combatant[]): number {
  let closest = Number.MAX_SAFE_INTEGER
  for (const enemy of enemies) closest = Math.min(closest, cellDistance(cellId, enemy.cellId))
  return closest === Number.MAX_SAFE_INTEGER ? -1 : closest
}

/** Enemies that could walk into contact with a cell on their next turn. */
export function threatCount(cellId: number, enemies: Combatant[]): number {
  return enemies.filter((enemy) => cellDistance(cellId, enemy.cellId) <= enemy.threatRange).length
}
