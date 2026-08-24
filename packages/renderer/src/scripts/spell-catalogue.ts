import type { CombatElement } from '@dofemu/shared'
import type { DofusWindow } from '@/types/dofus-window'
import { zoneShapeOf, type ZoneDescription } from './zones'

/**
 * The character's spells, with everything a turn needs to be planned.
 *
 * Every constraint the game puts on a cast is read here — cost, range and
 * whether it is boostable, straight line, line of sight, free or occupied
 * cell, cooldown, casts per turn and per target — along with what each effect
 * does and the area it covers. A field the build does not expose comes back
 * null, and null means "no constraint" rather than a guess.
 */

type Dict = Record<string, unknown>

export type EffectKind = 'damage' | 'heal' | 'boost' | 'push' | 'pull' | 'summon' | 'other'

export interface SpellEffect {
  effectId: number | null
  /** Average of the dice, or the flat value. */
  average: number
  kind: EffectKind
  element: CombatElement | null
  zone: ZoneDescription
  /** Effects that only fire later in the fight are worth less now. */
  delay: number
}

export interface SpellDetails {
  id: number
  name: string | null
  level: number | null

  apCost: number | null
  range: number
  minRange: number
  rangeBoostable: boolean

  castInLine: boolean
  castInDiagonal: boolean
  needsLineOfSight: boolean
  needsFreeCell: boolean
  needsTakenCell: boolean

  /** Range this spell grants while its boost is up, 0 when it grants none. */
  rangeBoost: number

  /** Turns between two casts. 0 means every turn. */
  cooldown: number
  maxCastsPerTurn: number | null
  maxCastsPerTarget: number | null

  /** Area of the spell's main effect. */
  zone: ZoneDescription
  effects: SpellEffect[]

  /** Damage the spell is worth on one target, averaged. */
  damage: number
  /** Life it gives back. */
  heal: number
  kind: EffectKind
  elements: CombatElement[]
  pushes: boolean
}

/**
 * Effect ids that carry an element, as far as they are known.
 *
 * An id missing here yields no element, and a spell with no element is never
 * filtered out — a gap in this table must not silently disable a spell.
 */
const DAMAGE_EFFECTS: Record<number, CombatElement> = {
  91: 'water',
  92: 'earth',
  93: 'air',
  94: 'fire',
  95: 'neutral',
  96: 'earth',
  97: 'earth',
  98: 'water',
  99: 'air',
  100: 'fire',
  101: 'neutral',
  82: 'neutral'
}

const HEAL_EFFECTS = new Set([81, 108])
const PUSH_EFFECTS = new Set([5, 6])
const PULL_EFFECTS = new Set([7, 8])
const SUMMON_EFFECTS = new Set([181, 185])
/** Boosts that widen the range of every boostable spell — "Portée". */
const RANGE_EFFECTS = new Set([117])
const BOOST_EFFECTS = new Set([
  111, 112, 115, 117, 118, 119, 120, 122, 123, 124, 125, 126, 127, 128, 138, 178, 182, 265
])

function asDict(value: unknown): Dict | null {
  return value && typeof value === 'object' ? (value as Dict) : null
}

/**
 * The character's Portée, gear and buffs included.
 *
 * A spell's own range is only its base: the range characteristic adds to
 * every spell flagged boostable, and that characteristic moves during the
 * fight — a bow mastery raises it for a couple of turns. Reading it from the
 * fighter rather than from the sheet is what makes the boost count: the
 * fighter's statistics carry what the fight has applied, the sheet does not.
 */
export function readRangeBonus(gameWindow: DofusWindow): number {
  const gui = asDict(gameWindow.gui)
  const playerData = asDict(gui?.playerData)
  const myId = asNumber(asDict(playerData?.characterBaseInformations)?.id)

  const fighters = asDict(gui?.fightManager)?.fighters
  const list = Array.isArray(fighters) ? fighters : Object.values(asDict(fighters) ?? {})
  const mine = list
    .map((fighter) => asDict(fighter))
    .find((fighter) => fighter !== null && asNumber(fighter.id) === myId)

  const inFight = characteristic(asDict(asDict(mine?.data)?.stats), 'range')
  if (inFight !== null) return inFight

  const sheet =
    asDict(asDict(asDict(playerData?.characters)?.mainCharacter)?.characteristics) ??
    asDict(playerData?.characteristics)

  return characteristic(sheet, 'range') ?? 0
}

/** A characteristic is spread over base, gear and buffs: they all count. */
function characteristic(source: Dict | null, name: string): number | null {
  const raw = source?.[name]
  if (typeof raw === 'number') return raw

  const dict = asDict(raw)
  if (!dict) return null

  return ['base', 'additional', 'objectsAndMountBonus', 'alignGiftBonus', 'contextModif']
    .map((key) => (typeof dict[key] === 'number' ? (dict[key] as number) : 0))
    .reduce((total, value) => total + value, 0)
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function kindOf(effectId: number | null, element: CombatElement | null): EffectKind {
  if (element !== null) return 'damage'
  if (effectId === null) return 'other'
  if (HEAL_EFFECTS.has(effectId)) return 'heal'
  if (PUSH_EFFECTS.has(effectId)) return 'push'
  if (PULL_EFFECTS.has(effectId)) return 'pull'
  if (SUMMON_EFFECTS.has(effectId)) return 'summon'
  if (BOOST_EFFECTS.has(effectId)) return 'boost'
  return 'other'
}

function readEffect(raw: unknown): SpellEffect | null {
  const dict = asDict(raw)
  if (!dict) return null

  const effectId = asNumber(dict.effectId) ?? asNumber(dict.effectType) ?? null
  const min = asNumber(dict.diceNum) ?? asNumber(dict.value) ?? 0
  const max = asNumber(dict.diceSide) ?? 0
  const average = max > min ? (min + max) / 2 : min

  const element = effectId !== null ? (DAMAGE_EFFECTS[effectId] ?? null) : null

  return {
    effectId,
    average,
    kind: kindOf(effectId, element),
    element,
    zone: {
      shape: zoneShapeOf((dict.zoneShape as number | string | undefined) ?? null),
      size: asNumber(dict.zoneSize) ?? 0,
      minSize: asNumber(dict.zoneMinSize) ?? 0
    },
    delay: asNumber(dict.delay) ?? 0
  }
}

function readLevel(spell: Dict): Dict | null {
  return (
    asDict(spell.spellLevel) ??
    asDict(asDict(spell.spell)?.spellLevel) ??
    asDict(spell.level) ??
    null
  )
}

function readName(dict: Dict, spell: Dict | null): string | null {
  if (typeof dict.name === 'string' && dict.name.trim()) return dict.name
  if (typeof spell?.nameId === 'string' && spell.nameId.trim()) return spell.nameId
  if (typeof dict.getName === 'function') {
    try {
      const called = (dict.getName as () => unknown)()
      if (typeof called === 'string' && called.trim()) return called
    } catch {}
  }
  return null
}

/** Everything the character can cast, with the numbers a plan needs. */
export function readSpellCatalogue(gameWindow: DofusWindow): SpellDetails[] {
  const playerData = asDict(asDict(gameWindow.gui)?.playerData)
  const spellData =
    asDict(asDict(asDict(playerData?.characters)?.mainCharacter)?.spellData) ??
    asDict(playerData?.spellData)

  let entries: unknown[] = []
  for (const key of ['spells', 'spellsBySpellId', 'spellList']) {
    const container = spellData?.[key]
    if (!container || typeof container !== 'object') continue
    const list = Array.isArray(container) ? container : Object.values(container)
    if (list.length > 0) {
      entries = list
      break
    }
  }

  const catalogue: SpellDetails[] = []
  const rangeBonus = readRangeBonus(gameWindow)

  for (const raw of entries) {
    const dict = asDict(raw)
    if (!dict) continue

    const spell = asDict(dict.spell)
    const id = asNumber(dict.id) ?? asNumber(dict.spellId) ?? asNumber(spell?.id)
    if (id === null) continue

    const level = readLevel(dict)
    const effectSource = level?.effects ?? dict.effects
    const effects = (Array.isArray(effectSource) ? effectSource : [])
      .map(readEffect)
      .filter((effect): effect is SpellEffect => effect !== null)

    // Damage that lands later — poison and the like — still counts, at a
    // discount, so a damage-over-time spell is usable without being preferred
    // to one that hits now.
    const damage = effects
      .filter((effect) => effect.kind === 'damage')
      .reduce((total, effect) => total + effect.average * (effect.delay > 0 ? 0.6 : 1), 0)
    const heal = effects
      .filter((effect) => effect.kind === 'heal')
      .reduce((total, effect) => total + effect.average, 0)

    const kind: EffectKind =
      damage > 0
        ? 'damage'
        : heal > 0
          ? 'heal'
          : (effects.find((effect) => effect.kind !== 'other')?.kind ?? 'other')

    // The area is the widest one among the effects that matter.
    const zone = effects
      .filter((effect) => effect.kind === 'damage' || effect.kind === 'heal')
      .reduce<ZoneDescription>(
        (widest, effect) => (effect.zone.size > widest.size ? effect.zone : widest),
        { shape: 'point', size: 0, minSize: 0 }
      )

    catalogue.push({
      id,
      name: readName(dict, spell),
      level: asNumber(level?.grade) ?? asNumber(dict.level),

      apCost: asNumber(level?.apCost) ?? asNumber(dict.apCost),
      // Boostable spells reach as far as the character's Portée takes them,
      // which is what makes a range buff worth casting before an attack.
      range:
        (asNumber(level?.range) ?? asNumber(dict.range) ?? 1) +
        (asBoolean(level?.rangeCanBeBoosted, false) ? rangeBonus : 0),
      minRange: asNumber(level?.minRange) ?? asNumber(dict.minRange) ?? 0,
      rangeBoostable: asBoolean(level?.rangeCanBeBoosted, false),

      castInLine: asBoolean(level?.castInLine, false),
      castInDiagonal: asBoolean(level?.castInDiagonal, false),
      needsLineOfSight: asBoolean(level?.castTestLos, true),
      needsFreeCell: asBoolean(level?.needFreeCell, false),
      needsTakenCell: asBoolean(level?.needTakenCell, false),

      rangeBoost: effects
        .filter((effect) => effect.effectId !== null && RANGE_EFFECTS.has(effect.effectId))
        .reduce((total, effect) => total + effect.average, 0),

      cooldown: asNumber(level?.minCastInterval) ?? 0,
      maxCastsPerTurn: asNumber(level?.maxCastPerTurn),
      maxCastsPerTarget: asNumber(level?.maxCastPerTarget),

      zone,
      effects,
      damage,
      heal,
      kind,
      elements: [
        ...new Set(
          effects
            .map((effect) => effect.element)
            .filter((element): element is CombatElement => element !== null)
        )
      ],
      pushes: effects.some((effect) => effect.kind === 'push')
    })
  }

  return catalogue
}
