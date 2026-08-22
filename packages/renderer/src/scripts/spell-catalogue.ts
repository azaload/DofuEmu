import type { CombatElement } from '@dofemu/shared'
import type { DofusWindow } from '@/types/dofus-window'

/**
 * The character's spells, as the game describes them.
 *
 * Everything a turn needs to be planned without being told: cost, range, the
 * shape of the area, whether it must be thrown in a straight line, whether it
 * needs to see its target, and how often it may be cast.
 *
 * Fields the build does not expose come back null, and the planner treats a
 * null as "no constraint" rather than guessing.
 */

type Dict = Record<string, unknown>

export interface SpellEffect {
  effectId: number | null
  /** Average of the dice, when the effect rolls any. */
  average: number
  zoneShape: number | string | null
  zoneSize: number | null
  element: CombatElement | null
  /** Damage, or a boost the character puts on itself. */
  kind: 'damage' | 'heal' | 'boost' | 'other'
}

export interface SpellDetails {
  id: number
  name: string | null
  level: number | null
  apCost: number | null
  range: number
  minRange: number
  /** Only along a grid axis. */
  castInLine: boolean
  /** Needs a clear line to its target. */
  needsLineOfSight: boolean
  /** Turns to wait between two casts. */
  cooldown: number | null
  maxCastsPerTurn: number | null
  maxCastsPerTarget: number | null
  zoneShape: number | string | null
  zoneSize: number | null
  /** Damage this spell is worth, averaged over its effects. */
  damage: number
  /** What the spell is for, decided by its effects. */
  kind: 'damage' | 'heal' | 'boost' | 'other'
  elements: CombatElement[]
}

/**
 * Effect ids that carry an element, as far as they are known.
 *
 * An id missing here yields no element, and a spell with no element is never
 * filtered out — a wrong table must not silently disable a spell.
 */
const DAMAGE_EFFECTS: Record<number, CombatElement> = {
  96: 'earth',
  97: 'earth',
  98: 'water',
  99: 'air',
  100: 'fire',
  101: 'neutral',
  91: 'water',
  92: 'earth',
  93: 'air',
  94: 'fire',
  95: 'neutral'
}

const HEAL_EFFECTS = new Set([108, 81])
const BOOST_EFFECTS = new Set([
  111, 112, 115, 117, 118, 119, 120, 123, 124, 125, 126, 128, 138, 178, 182
])

function asDict(value: unknown): Dict | null {
  return value && typeof value === 'object' ? (value as Dict) : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function readEffect(raw: unknown): SpellEffect | null {
  const dict = asDict(raw)
  if (!dict) return null

  const effectId = asNumber(dict.effectId) ?? asNumber(dict.effectUid) ?? null
  const min = asNumber(dict.diceNum) ?? asNumber(dict.value) ?? 0
  const max = asNumber(dict.diceSide) ?? min
  const average = max > min ? (min + max) / 2 : min

  const element = effectId !== null ? (DAMAGE_EFFECTS[effectId] ?? null) : null
  const kind: SpellEffect['kind'] =
    element !== null
      ? 'damage'
      : effectId !== null && HEAL_EFFECTS.has(effectId)
        ? 'heal'
        : effectId !== null && BOOST_EFFECTS.has(effectId)
          ? 'boost'
          : 'other'

  return {
    effectId,
    average,
    zoneShape: (dict.zoneShape as number | string | undefined) ?? null,
    zoneSize: asNumber(dict.zoneSize),
    element,
    kind
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

/** Everything the character can cast, with the numbers a plan needs. */
export function readSpellCatalogue(gameWindow: DofusWindow): SpellDetails[] {
  const playerData = asDict(asDict(gameWindow.gui)?.playerData)
  const spellData =
    asDict(asDict(asDict(playerData?.characters)?.mainCharacter)?.spellData) ??
    asDict(playerData?.spellData)

  const containers = [spellData?.spells, spellData?.spellsBySpellId, spellData?.spellList]
  let entries: unknown[] = []
  for (const container of containers) {
    if (!container || typeof container !== 'object') continue
    const list = Array.isArray(container) ? container : Object.values(container)
    if (list.length > 0) {
      entries = list
      break
    }
  }

  const catalogue: SpellDetails[] = []

  for (const raw of entries) {
    const dict = asDict(raw)
    if (!dict) continue

    const spell = asDict(dict.spell)
    const id = asNumber(dict.id) ?? asNumber(dict.spellId) ?? asNumber(spell?.id)
    if (id === null) continue

    const levelData = readLevel(dict)
    const effectSource = levelData?.effects ?? dict.effects
    const effects = (Array.isArray(effectSource) ? effectSource : [])
      .map(readEffect)
      .filter((effect): effect is SpellEffect => effect !== null)

    const damage = effects
      .filter((effect) => effect.kind === 'damage')
      .reduce((total, effect) => total + effect.average, 0)

    const kind: SpellDetails['kind'] = damage > 0
      ? 'damage'
      : effects.some((effect) => effect.kind === 'heal')
        ? 'heal'
        : effects.some((effect) => effect.kind === 'boost')
          ? 'boost'
          : 'other'

    const zoned = effects.find((effect) => (effect.zoneSize ?? 0) > 0)

    let name = typeof dict.name === 'string' ? dict.name : null
    if (!name && typeof spell?.nameId === 'string') name = spell.nameId
    if (!name && typeof dict.getName === 'function') {
      try {
        const called = (dict.getName as () => unknown)()
        if (typeof called === 'string') name = called
      } catch {}
    }

    catalogue.push({
      id,
      name,
      level: asNumber(levelData?.grade) ?? asNumber(dict.level),
      apCost: asNumber(levelData?.apCost) ?? asNumber(dict.apCost),
      range: asNumber(levelData?.range) ?? asNumber(dict.range) ?? 1,
      minRange: asNumber(levelData?.minRange) ?? asNumber(dict.minRange) ?? 0,
      castInLine: asBoolean(levelData?.castInLine, false),
      needsLineOfSight: asBoolean(levelData?.castTestLos, true),
      cooldown: asNumber(levelData?.minCastInterval),
      maxCastsPerTurn: asNumber(levelData?.maxCastPerTurn),
      maxCastsPerTarget: asNumber(levelData?.maxCastPerTarget),
      zoneShape: zoned?.zoneShape ?? null,
      zoneSize: zoned?.zoneSize ?? null,
      damage,
      kind,
      elements: [
        ...new Set(
          effects
            .map((effect) => effect.element)
            .filter((element): element is CombatElement => element !== null)
        )
      ]
    })
  }

  return catalogue
}
