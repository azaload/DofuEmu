import type { CombatSettings } from '@dofemu/shared'
import type { FightState } from './fight-state'
import { parsePlan, validatePlan, type TurnAction, type TurnPlan } from './turn-plan'

/**
 * Asks a local model for the turn to play.
 *
 * The state handed over already contains only legal options — reachable cells
 * with what they see, spells with the enemies they can actually hit — so the
 * model picks among them instead of reasoning about geometry it would get
 * wrong. Whatever comes back is validated again before anything is sent.
 */

const SYSTEM_PROMPT = `You play one turn of a tactical fight, as a game engine would.
Your goal is to end the fight as fast as possible: every turn must damage an
enemy unless a spell that buffs or heals is clearly worth more.
Answer with JSON only: {"actions":[...],"reason":"short"}.
Actions are {"type":"move","cellId":N} and {"type":"cast","spellId":N,"targetId":N}.
"targetId" is the small "n" of an enemy, as listed in "enemies" — 1, 2, 3 — not its id.
Rules you must respect:
- at most one move, and only to a cellId listed in "cells"
- when "me.canMove" is false, plan no move at all: the character is held in
  contact by the ids in "me.tackledBy" and leaving is punished
- a spell with "push":true throws its target away, which breaks that hold
  without moving — prefer it when exactly one enemy holds the character
- only spellIds listed in "spells"
- a spell may only target an id listed in that spell's "targets"
- a spell with "self":true takes no targetId
- cast every spell you can: an unused action point is a wasted turn
- never end a turn having only moved, when an enemy is in reach of any spell
Order matters: the actions are played from first to last.`

export interface PlannerResult {
  actions: TurnAction[]
  reason?: string
  rejected: string[]
  elapsedMs: number
  error?: string
}

function challengeHint(state: FightState, preferChallenges: boolean): string {
  if (!preferChallenges || state.challenges.length === 0) return ''

  const described = state.challenges
    .map((challenge) => {
      const name = challenge.name ?? `#${challenge.id}`
      const description = challenge.description ? ` — ${challenge.description}` : ''
      const target = challenge.targetId !== null ? ` (concerns fighter ${challenge.targetId})` : ''
      return `- ${name}${description}${target}`
    })
    .join('\n')

  const rules = state.challengeRules
  const derived = [
    rules.noMove ? 'do not move at all' : null,
    rules.singleTarget ? 'hit a single enemy this turn' : null,
    rules.focusTargetId !== null ? `only fighter ${rules.focusTargetId} may be hit` : null,
    rules.avoidMelee ? 'do not end the turn next to an enemy' : null
  ].filter(Boolean)

  return `\nThe fight runs these challenges:\n${described}\nPlay the turn so they hold, even at the cost of damage.${
    derived.length > 0 ? `\nThat means: ${derived.join('; ')}.` : ''
  }`
}

export function buildPrompt(state: FightState, preferChallenges: boolean): string {
  return `Fight state:\n${JSON.stringify(state)}${challengeHint(state, preferChallenges)}\nAnswer with the JSON plan for turn ${state.turn}.`
}

export async function planTurnWithOllama(
  state: FightState,
  settings: CombatSettings
): Promise<PlannerResult> {
  const startedAt = Date.now()

  const response = await window.dofemu.ollamaChat({
    endpoint: settings.ollamaEndpoint,
    model: settings.ollamaModel,
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(state, settings.preferChallenges),
    timeoutMs: settings.ollamaTimeoutMs
  })

  if (!response.ok || !response.content) {
    return {
      actions: [],
      rejected: [],
      elapsedMs: response.elapsedMs ?? Date.now() - startedAt,
      error: response.error ?? 'the model answered nothing'
    }
  }

  const plan: TurnPlan | null = parsePlan(response.content)
  if (!plan) {
    return {
      actions: [],
      rejected: [],
      elapsedMs: response.elapsedMs ?? Date.now() - startedAt,
      error: 'the answer was not a plan'
    }
  }

  const { actions, rejected } = validatePlan(plan, state)
  return {
    actions,
    reason: plan.reason,
    rejected,
    elapsedMs: response.elapsedMs ?? Date.now() - startedAt
  }
}
