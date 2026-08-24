import type { CombatElement } from '@dofemu/shared'
import type { DofusWindow } from '@/types/dofus-window'
import type { Fighter } from './fight-bridge'
import type { SpellDetails } from './spell-catalogue'

/**
 * What a spell actually takes off a given monster.
 *
 * A base value is only a starting point: the character's own statistics
 * multiply it, and the target's resistances cut it back. Which spell hits
 * hardest therefore depends on who is being hit — the fire one on a monster
 * that resists earth, and the other way round.
 *
 * The formula is the game's: base × (1 + stat% + damage%) + flat damage, then
 * the target's percentage resistance, then its flat reduction. Anything the
 * client does not expose reads as zero, which leaves the base value untouched
 * rather than inventing a bonus.
 */

type Dict = Record<string, unknown>

export interface DamageProfile {
  /** Characteristic behind each element, already totalled. */
  stat: Record<CombatElement, number>
  /** Percentage bonus that applies to everything. */
  damagePercent: number
  /** Flat bonus, all elements and then per element. */
  flat: Record<CombatElement, number>
  /** Extra percentage against every element, from "damage inflicted". */
  finalPercent: number
}

const ELEMENTS: CombatElement[] = ['fire', 'earth', 'water', 'air', 'neutral']

function asDict(value: unknown): Dict | null {
  return value && typeof value === 'object' ? (value as Dict) : null
}

/** A characteristic is spread over base, gear and buffs: they all count. */
function characteristic(source: Dict | null, name: string): number {
  const raw = source?.[name]
  if (typeof raw === 'number') return raw

  const dict = asDict(raw)
  if (!dict) return 0

  // The protocol spells it "additionnal"; some builds use the English one.
  return ['base', 'additional', 'additionnal', 'objectsAndMountBonus', 'alignGiftBonus', 'contextModif']
    .map((key) => (typeof dict[key] === 'number' ? (dict[key] as number) : 0))
    .reduce((total, value) => total + value, 0)
}

export function readDamageProfile(gameWindow: DofusWindow): DamageProfile {
  const playerData = asDict(asDict(gameWindow.gui)?.playerData)
  const stats =
    asDict(asDict(asDict(playerData?.characters)?.mainCharacter)?.characteristics) ??
    asDict(playerData?.characteristics)

  const strength = characteristic(stats, 'strength')
  const intelligence = characteristic(stats, 'intelligence')
  const chance = characteristic(stats, 'chance')
  const agility = characteristic(stats, 'agility')

  const all = characteristic(stats, 'allDamagesBonus')

  return {
    stat: {
      earth: strength,
      neutral: strength,
      fire: intelligence,
      water: chance,
      air: agility
    },
    damagePercent: characteristic(stats, 'damagesBonusPercent'),
    flat: {
      earth: all + characteristic(stats, 'earthDamageBonus'),
      neutral: all + characteristic(stats, 'neutralDamageBonus'),
      fire: all + characteristic(stats, 'fireDamageBonus'),
      water: all + characteristic(stats, 'waterDamageBonus'),
      air: all + characteristic(stats, 'airDamageBonus')
    },
    finalPercent: characteristic(stats, 'damagesMultiplicator')
  }
}

export interface Resistances {
  percent: Record<CombatElement, number>
  flat: Record<CombatElement, number>
}

const RESIST_PERCENT: Record<CombatElement, string> = {
  earth: 'earthElementResistPercent',
  fire: 'fireElementResistPercent',
  water: 'waterElementResistPercent',
  air: 'airElementResistPercent',
  neutral: 'neutralElementResistPercent'
}

const RESIST_FLAT: Record<CombatElement, string> = {
  earth: 'earthElementReduction',
  fire: 'fireElementReduction',
  water: 'waterElementReduction',
  air: 'airElementReduction',
  neutral: 'neutralElementReduction'
}

/** What a fighter resists, as the fight reports it. */
export function readResistances(fighter: Fighter): Resistances {
  const stats = asDict(fighter.stats)

  const percent = {} as Record<CombatElement, number>
  const flat = {} as Record<CombatElement, number>

  for (const element of ELEMENTS) {
    percent[element] = characteristic(stats, RESIST_PERCENT[element])
    flat[element] = characteristic(stats, RESIST_FLAT[element])
  }

  return { percent, flat }
}

/**
 * Damage `spell` is expected to take off `target`.
 *
 * Every damaging effect is costed separately, since a spell can carry two
 * elements and a monster rarely resists both the same way.
 */
export function damageAgainst(
  spell: SpellDetails,
  target: Fighter,
  profile: DamageProfile
): number {
  const resistances = readResistances(target)
  let total = 0

  for (const effect of spell.effects) {
    if (effect.kind !== 'damage' || effect.element === null) continue

    const element = effect.element
    // Damage that lands on a later turn is worth less than damage now.
    const timing = effect.delay > 0 ? 0.6 : 1
    const boosted =
      effect.average * (1 + (profile.stat[element] + profile.damagePercent) / 100) +
      profile.flat[element]

    const afterPercent = boosted * (1 - resistances.percent[element] / 100)
    const afterFlat = afterPercent - resistances.flat[element]
    const multiplied = afterFlat * (1 + profile.finalPercent / 100)

    total += Math.max(0, multiplied) * timing
  }

  // A spell whose elements the client does not expose still hits for something.
  return total > 0 ? total : spell.damage
}
