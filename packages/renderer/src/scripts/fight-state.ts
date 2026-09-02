import type { DofusWindow } from '@/types/dofus-window'

/**
 * The challenges a fight is running, and what they can be read to forbid.
 *
 * The protocol carries ids only, so the wording comes from the panel on
 * screen — and the wording is the whole point: an id says nothing about what
 * a challenge asks for.
 *
 * Nothing here constrains the AI. Holding a challenge is worth nothing if it
 * costs the fight or drags it out, and a fragile character pays that price
 * quickly. The rules are derived so they can be *shown* to the local model,
 * which may favour them when they are cheap.
 */

export interface FightChallenge {
  id: number
  name: string | null
  /** What the game says the challenge asks for, when it is on screen. */
  description: string | null
  /** Fighter the challenge points at, when it names one. */
  targetId: number | null
}

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
        const id =
          typeof dict.id === 'number'
            ? dict.id
            : typeof dict.challengeId === 'number'
              ? dict.challengeId
              : null
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
export function readChallengeTexts(
  gameWindow: DofusWindow
): Array<{ name: string; description: string | null }> {
  const found: Array<{ name: string; description: string | null }> = []

  try {
    for (const element of gameWindow.document.querySelectorAll(
      '.challenge, .challengeSlot, .challengeIcon, [class*="hallenge"]'
    )) {
      const host = element as HTMLElement
      if (host.offsetParent === null) continue

      const name = (host.querySelector('.title, .name, .challengeName') as HTMLElement | null)
        ?.innerText
      const description = (
        host.querySelector('.description, .desc, .challengeDescription') as HTMLElement | null
      )?.innerText
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
