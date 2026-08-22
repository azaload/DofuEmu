import type { DofusWindow } from '@/types/dofus-window'
import { attackMonsterGroup } from './game-bridge'

/**
 * Starting a fight the way a player does.
 *
 * In game you tap the monster group and a green "Attaquer" button appears —
 * the fight starts when that button is pressed. So the group is handed to the
 * engine first, then the button is clicked; the raw network request is only a
 * last resort, since on its own the server ignores it.
 */

type Dict = Record<string, unknown>

/** Engine entry points seen for "the player tapped this actor". */
export const TAP_METHODS = [
  'attackMonsterGroup',
  'attackMonster',
  'startFightWithMonsterGroup',
  'onMonsterGroupSelected',
  'selectActor',
  'selectTarget',
  'tapActor',
  'onActorTap',
  '_onActorTap',
  'onActorSelected',
  'showActorMenu',
  'openContextualMenu'
]

export interface AttackOwner {
  label: string
  value: unknown
}

/** Objects that may carry one of those entry points. */
export function attackOwners(gameWindow: DofusWindow): AttackOwner[] {
  const isoEngine = asDict(gameWindow.isoEngine)
  return [
    { label: 'isoEngine', value: isoEngine },
    { label: 'actorManager', value: asDict(isoEngine?.actorManager) ?? asDict(gameWindow.actorManager) },
    { label: 'gui', value: asDict(gameWindow.gui) },
    { label: 'mapScene', value: asDict(isoEngine?.mapScene) }
  ]
}

const ATTACK_LABEL = /(attaquer|attack|angreifen|atacar|attacca)/i
const CLICKABLE = 'button, .button, [role="button"], .btn, .greenButton, .confirmButton, span, div, li, a'

function asDict(value: unknown): Dict | null {
  return value && typeof value === 'object' ? (value as Dict) : null
}

function isVisible(element: Element): boolean {
  const host = element as HTMLElement
  if (typeof host.offsetParent === 'undefined') return true
  if (host.offsetParent === null) return false
  const rect = host.getBoundingClientRect?.()
  return !rect || (rect.width > 0 && rect.height > 0)
}

/** Text of an element, without the accents and casing that vary by locale. */
function labelOf(element: Element): string {
  const raw = (element as HTMLElement).innerText ?? element.textContent ?? ''
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The button or menu entry that starts the fight.
 *
 * The label is matched loosely — a menu row can carry extra text — and only
 * the innermost element holding it is returned, so the click lands on the row
 * itself rather than on a container that ignores it.
 */
export function findAttackButton(gameWindow: DofusWindow): HTMLElement | null {
  try {
    const matches: HTMLElement[] = []

    for (const element of gameWindow.document.querySelectorAll(CLICKABLE)) {
      const label = labelOf(element)
      if (label.length === 0 || label.length > 40) continue
      if (!ATTACK_LABEL.test(label)) continue
      if (!isVisible(element)) continue
      matches.push(element as HTMLElement)
    }

    // Deepest match wins: a parent panel usually carries the same text.
    return (
      matches
        .filter((element) => !matches.some((other) => other !== element && element.contains(other)))
        .shift() ?? null
    )
  } catch {}
  return null
}

/** Short visible texts on screen — what a menu or panel is offering. */
export function visibleLabels(gameWindow: DofusWindow, max = 30): string[] {
  try {
    const seen = new Set<string>()
    for (const element of gameWindow.document.querySelectorAll(CLICKABLE)) {
      if (!isVisible(element)) continue
      const label = labelOf(element)
      if (label.length === 0 || label.length > 30) continue
      seen.add(label)
      if (seen.size >= max) break
    }
    return [...seen]
  } catch {
    return []
  }
}

export function callWithGroup(owner: unknown, method: string, groupId: number): boolean {
  const dict = asDict(owner)
  if (!dict) return false
  const fn = dict[method]
  if (typeof fn !== 'function') return false

  // Builds pass the actor id, the actor itself, or an event-like object.
  const actors = asDict(asDict(dict.actorManager)?.actors)
  const actor = asDict(actors?.[String(groupId)])
  for (const args of [[groupId], [actor ?? groupId], [{ id: groupId }], [groupId, true]]) {
    try {
      ;(fn as (...args: unknown[]) => void).apply(dict, args)
      return true
    } catch {
      // Wrong shape for this build; try the next one.
    }
  }

  return false
}

export interface AttackAttempt {
  strategy: string
  detail?: string
}

/**
 * Asks the game to attack `groupId`, trying the player's own flow first.
 * Returns every step taken, for the script log.
 */
export function requestAttack(gameWindow: DofusWindow, groupId: number): AttackAttempt[] {
  const attempts: AttackAttempt[] = []
  const isoEngine = asDict(gameWindow.isoEngine)
  const actorManager = asDict(isoEngine?.actorManager) ?? asDict(gameWindow.actorManager)
  const gui = asDict(gameWindow.gui)

  for (const [label, owner] of [
    ['isoEngine', isoEngine],
    ['actorManager', actorManager],
    ['gui', gui]
  ] as const) {
    for (const method of TAP_METHODS) {
      if (callWithGroup(owner, method, groupId)) {
        attempts.push({ strategy: `${label}.${method}()` })
        break
      }
    }
  }

  const button = findAttackButton(gameWindow)
  if (button) {
    try {
      button.click()
      attempts.push({ strategy: 'attack button', detail: button.className || button.tagName })
    } catch (err) {
      attempts.push({
        strategy: 'attack button',
        detail: `click failed: ${err instanceof Error ? err.message : String(err)}`
      })
    }
  }

  if (attempts.length === 0) {
    attackMonsterGroup(gameWindow, groupId)
    attempts.push({ strategy: 'GameRolePlayAttackMonsterRequestMessage' })
  }

  return attempts
}

/**
 * Names of the members the game exposes, filtered by `pattern`.
 * The client is minified and differs between builds, so this is how an
 * unknown shape gets reported instead of guessed at.
 */
export function describeGameApi(
  gameWindow: DofusWindow,
  pattern = 'attack|monster|tap|fight|move|walk|path|cell|click|press'
): string[] {
  const regex = new RegExp(pattern, 'i')
  const lines: string[] = []

  const describe = (label: string, value: unknown) => {
    const dict = asDict(value)
    if (!dict) {
      lines.push(`${label}: missing`)
      return
    }
    const names = new Set<string>()
    let current: object | null = dict
    for (let depth = 0; current && depth < 3; depth++) {
      for (const key of Object.getOwnPropertyNames(current)) {
        if (regex.test(key)) names.add(key)
      }
      current = Object.getPrototypeOf(current)
    }
    lines.push(`${label}: ${names.size > 0 ? [...names].join(' ') : 'nothing matching'}`)
  }

  describe('isoEngine', gameWindow.isoEngine)
  describe('isoEngine.actorManager', asDict(gameWindow.isoEngine)?.actorManager)
  describe('isoEngine.mapScene', asDict(gameWindow.isoEngine)?.mapScene)
  describe('gui', gameWindow.gui)

  // A monster group actor, whose own members reveal how the client drives it.
  const actors = asDict(asDict(asDict(gameWindow.isoEngine)?.actorManager)?.actors)
  const monster = actors
    ? Object.entries(actors).find(([, actor]) => asDict(asDict(actor)?.data)?.staticInfos)
    : undefined
  if (monster) {
    describe(`monster actor ${monster[0]}`, monster[1])
  } else {
    lines.push('monster actor: none on this map')
  }

  const labels = visibleLabels(gameWindow)
  lines.push(`visible labels: ${labels.join(' | ') || 'none'}`)

  return lines
}
