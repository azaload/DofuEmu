import type { FightState } from './fight-state'

/**
 * A turn as a list of actions.
 *
 * Whatever produces a plan — rules or a model — every action is checked
 * against the state it was built from before anything is sent to the game. A
 * model that invents a cell or a target loses that action, not the turn.
 */

export interface MoveAction {
  type: 'move'
  cellId: number
}

export interface CastAction {
  type: 'cast'
  spellId: number
  /** Fighter to aim at. Omitted for a spell cast on ourselves. */
  targetId?: number
}

export type TurnAction = MoveAction | CastAction

export interface TurnPlan {
  actions: TurnAction[]
  /** One line from the planner, for the activity log. */
  reason?: string
}

export interface ValidationResult {
  actions: TurnAction[]
  rejected: string[]
}

/** Keeps the actions the state actually allows, and says why the others went. */
export function validatePlan(plan: TurnPlan, state: FightState): ValidationResult {
  const actions: TurnAction[] = []
  const rejected: string[] = []
  let moved = false

  for (const action of plan.actions ?? []) {
    if (!action || typeof action !== 'object') {
      rejected.push('not an action')
      continue
    }

    if (action.type === 'move') {
      if (state.me.canMove === false) {
        rejected.push(`move to ${action.cellId}: held in contact, moving is tackled`)
        continue
      }
      if (moved) {
        rejected.push(`move to ${action.cellId}: only one move per turn`)
        continue
      }
      const cell = state.cells.find((candidate) => candidate.cellId === action.cellId)
      if (!cell) {
        rejected.push(`move to ${action.cellId}: not reachable this turn`)
        continue
      }
      moved = true
      actions.push({ type: 'move', cellId: cell.cellId })
      continue
    }

    if (action.type === 'cast') {
      const spell = state.spells.find((candidate) => candidate.id === action.spellId)
      if (!spell) {
        rejected.push(`cast ${action.spellId}: not in the combo`)
        continue
      }

      if (spell.self || action.targetId === undefined) {
        if (!spell.self) {
          rejected.push(`cast ${action.spellId}: no target given`)
          continue
        }
        actions.push({ type: 'cast', spellId: spell.id })
        continue
      }

      const enemy = state.enemies.find((candidate) => candidate.id === action.targetId)
      if (!enemy) {
        rejected.push(`cast ${action.spellId} on ${action.targetId}: unknown target`)
        continue
      }

      // Reach is only known for where the character stands now. After a move
      // the game refuses what it must; the point here is to drop the obvious.
      if (!moved && !spell.targets.includes(enemy.id)) {
        rejected.push(`cast ${action.spellId} on ${enemy.id}: out of reach or no line of sight`)
        continue
      }

      actions.push({ type: 'cast', spellId: spell.id, targetId: enemy.id })
      continue
    }

    rejected.push(`unknown action "${(action as { type?: string }).type ?? '?'}"`)
  }

  return { actions, rejected }
}

/** Parses the JSON a model answered with, tolerating the prose around it. */
export function parsePlan(raw: string): TurnPlan | null {
  const text = raw.trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null

  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<TurnPlan>
    if (!Array.isArray(parsed.actions)) return null
    return {
      actions: parsed.actions.filter((action): action is TurnAction => !!action && typeof action === 'object'),
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : undefined
    }
  } catch {
    return null
  }
}
