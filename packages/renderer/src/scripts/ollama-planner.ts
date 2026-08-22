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
Answer with JSON only: {"actions":[...],"reason":"short"}.
Actions are {"type":"move","cellId":N} and {"type":"cast","spellId":N,"targetId":N}.
Rules you must respect:
- at most one move, and only to a cellId listed in "cells"
- only spellIds listed in "spells"
- a spell may only target an id listed in that spell's "targets"
- a spell with "self":true takes no targetId
- prefer casting every action point over saving it
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
  const named = state.challenges
    .map((challenge) => challenge.name ?? `#${challenge.id}`)
    .join(', ')
  return `\nThe fight runs these challenges: ${named}. Play the turn so they hold, even at the cost of damage.`
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
