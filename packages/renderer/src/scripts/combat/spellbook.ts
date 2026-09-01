import type { CombatElement } from '@dofemu/shared'
import type { DofusWindow } from '@/types/dofus-window'
import { readSpellCatalogue, type SpellDetails } from '../spell-catalogue'

/**
 * Every spell the character owns, and what the fight has done with it.
 *
 * The catalogue says what a spell is; this says whether it may be cast right
 * now, at what price, and — when it may not — why. A turn that ends with
 * action points to spare and a reason for every spell it did not cast is a
 * turn that can be argued with; one that just ends is not.
 */

export type Unavailable =
  | 'element'
  | 'cooldown'
  | 'casts-this-turn'
  | 'action-points'
  | 'unreadable'

export interface SpellState {
  spell: SpellDetails
  /** What the spell costs this turn, its escalation included. */
  apCost: number
  /** Casts already played this turn, across every re-plan. */
  castsThisTurn: number
  /** Casts left this turn, or null when the spell sets no limit. */
  castsLeft: number | null
  /** Our own turn the spell was last cast on, or null. */
  lastCastTurn: number | null
  /** Turns still to wait before it may be cast again. */
  cooldownLeft: number
  usable: boolean
  reason: Unavailable | null
}

export interface SpellbookOptions {
  turn: number
  /** Elements the character is allowed to use. Empty means all of them. */
  elements: CombatElement[]
  /** Our own turn each spell was last cast on. */
  lastCastTurn: ReadonlyMap<number, number>
  /** Casts already played this turn, per spell. */
  castsThisTurn?: ReadonlyMap<number, number>
  /** Prices the turn has learnt, for spells that grow with use. */
  apCosts?: ReadonlyMap<number, number>
  actionPoints: number
  /** Spells the fight has already refused outright — a state, a condition. */
  disabled?: ReadonlySet<number>
  /**
   * Read these spells instead of the character's whole book.
   *
   * The manual combo is a list of spells and nothing else: when it is what
   * the turn plays, it is also what the turn may choose from.
   */
  catalogue?: SpellDetails[]
}

export interface Spellbook {
  /** Everything the character owns, whatever its state. */
  all: SpellDetails[]
  /** Every spell with its state, in the catalogue's order. */
  states: SpellState[]
  /** The ones that may be cast right now. */
  usable: SpellState[]
  /** Usable spells that take life off something. */
  attacks: SpellState[]
  /** Usable masteries — kept up whenever the points allow. */
  masteries: SpellState[]
  /** Usable spells that give life back. */
  heals: SpellState[]
  /** The cheapest attack available, so a buff never eats the points to hit with. */
  cheapestAttack: number
  /** The longest reach any attack has right now. */
  longestReach: number
}

/**
 * Whether the character is allowed to use this spell's damage.
 *
 * A spell whose element the client does not expose is never filtered out: a
 * gap in that reading must not silently disable a spell.
 */
export function elementAllowed(spell: SpellDetails, allowed: CombatElement[]): boolean {
  if (spell.elements.length === 0) return true
  if (allowed.length === 0) return true
  return spell.elements.some((element) => allowed.includes(element))
}

/**
 * A cooldown counts the turns to wait *between* casts.
 *
 * So a spell without one may be cast again on the same turn — twice, three
 * times, as long as the points last. Reading the cast just played as a
 * cooldown is what quietly limited every spell to one cast a turn.
 */
export function cooldownLeft(
  spell: SpellDetails,
  turn: number,
  lastCastTurn: ReadonlyMap<number, number>
): number {
  const last = lastCastTurn.get(spell.id)
  if (last === undefined) return 0
  return Math.max(0, spell.cooldown - (turn - last))
}

export function readSpellbook(gameWindow: DofusWindow, options: SpellbookOptions): Spellbook {
  const all = options.catalogue ?? readSpellCatalogue(gameWindow)
  const states: SpellState[] = []

  for (const spell of all) {
    const apCost = options.apCosts?.get(spell.id) ?? spell.apCost ?? 0
    const castsThisTurn = options.castsThisTurn?.get(spell.id) ?? 0
    const perTurn = spell.maxCastsPerTurn
    const castsLeft = perTurn === null ? null : Math.max(0, perTurn - castsThisTurn)
    const waiting = cooldownLeft(spell, options.turn, options.lastCastTurn)

    let reason: Unavailable | null = null
    if (options.disabled?.has(spell.id)) reason = 'unreadable'
    else if (!elementAllowed(spell, options.elements)) reason = 'element'
    else if (waiting > 0) reason = 'cooldown'
    else if (castsLeft !== null && castsLeft <= 0) reason = 'casts-this-turn'
    else if (apCost > options.actionPoints) reason = 'action-points'
    else if (spell.kind !== 'damage' && spell.kind !== 'heal' && spell.kind !== 'boost') {
      reason = 'unreadable'
    }

    states.push({
      spell,
      apCost,
      castsThisTurn,
      castsLeft,
      lastCastTurn: options.lastCastTurn.get(spell.id) ?? null,
      cooldownLeft: waiting,
      usable: reason === null,
      reason
    })
  }

  const usable = states.filter((state) => state.usable)
  const attacks = usable.filter((state) => state.spell.kind === 'damage')
  const masteries = usable.filter((state) => state.spell.isMastery)

  return {
    all,
    states,
    usable,
    attacks,
    masteries,
    heals: usable.filter((state) => state.spell.kind === 'heal'),
    cheapestAttack: attacks.length === 0
      ? Number.MAX_SAFE_INTEGER
      : Math.min(...attacks.map((state) => state.apCost)),
    longestReach: attacks.length === 0
      ? 0
      : Math.max(...attacks.map((state) => state.spell.range))
  }
}

/** Why a spell could not be cast, in words fit for the activity log. */
export function explain(state: SpellState, actionPoints: number, elements: CombatElement[]): string {
  const name = state.spell.name ?? `spell ${state.spell.id}`
  switch (state.reason) {
    case 'element':
      return `${name}: ${state.spell.elements.join('/')} not ticked in Elements (${
        elements.join(', ') || 'none'
      })`
    case 'cooldown':
      return `${name}: on cooldown for ${state.cooldownLeft} more turn(s)`
    case 'casts-this-turn':
      return `${name}: already cast ${state.castsThisTurn} time(s), its limit for a turn`
    case 'action-points':
      return `${name}: costs ${state.apCost} AP, ${actionPoints} left`
    case 'unreadable':
      return `${name}: effects not recognised`
    default:
      return `${name}: usable`
  }
}
