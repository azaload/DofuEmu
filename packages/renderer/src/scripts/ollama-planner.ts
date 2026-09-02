import type { CombatSettings } from '@dofemu/shared'
import type { CombatSnapshot } from './combat/snapshot'
import {
  SYSTEM_PROMPT,
  buildPrompt,
  parseModelAnswer,
  resolvePlan,
  type ModelAction
} from './combat/prompt'

/**
 * Asks a local model for the turn to play.
 *
 * The snapshot it is handed contains only legal options — every cast already
 * aimed, with what it would hit and what it would kill; every move with what
 * it unlocks — so the model chooses among them instead of reasoning about
 * geometry it would get wrong. Whatever comes back is checked against that
 * same snapshot before anything reaches the game.
 */

export { SYSTEM_PROMPT, buildPrompt }

export interface PlannerResult {
  actions: ModelAction[]
  reason?: string
  rejected: string[]
  elapsedMs: number
  error?: string
  /** The plan attacked nobody although something was in reach. */
  castsNothing: boolean
}

export async function planTurnWithOllama(
  snapshot: CombatSnapshot,
  settings: CombatSettings
): Promise<PlannerResult> {
  const startedAt = Date.now()

  const response = await window.dofemu.ollamaChat({
    endpoint: settings.ollamaEndpoint,
    model: settings.ollamaModel,
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(snapshot, settings.preferChallenges),
    timeoutMs: settings.ollamaTimeoutMs
  })

  const elapsedMs = response.elapsedMs ?? Date.now() - startedAt

  if (!response.ok || !response.content) {
    return {
      actions: [],
      rejected: [],
      elapsedMs,
      error: response.error ?? 'the model answered nothing',
      castsNothing: true
    }
  }

  const answer = parseModelAnswer(response.content)
  if (!answer) {
    return {
      actions: [],
      rejected: [],
      elapsedMs,
      error: 'the answer was not a plan',
      castsNothing: true
    }
  }

  const resolved = resolvePlan(snapshot, answer)
  return { ...resolved, elapsedMs }
}
