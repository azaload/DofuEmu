import type { CombatSnapshot, SnapshotCast } from './snapshot'

/**
 * What the local model is asked, and what it is allowed to answer.
 *
 * The model never names a cell, a spell or a target: every legal cast and
 * every legal move has already been worked out and given a key, and the
 * answer is a list of keys. A model that hallucinates cannot produce an
 * illegal turn — the worst it can do is choose a worse legal one, and the
 * rules take over when it does.
 *
 * The prompt is long on purpose. A small model has no idea how Dofus works;
 * everything it needs to weigh a turn is written down, in the order it should
 * weigh it.
 */

export const SYSTEM_PROMPT = `You play one turn of a Dofus tactical fight for a character, and you play it to win.

HOW THE FIGHT IS DESCRIBED
You are given JSON with these parts:
- "me": the character. "cell" is where it stands, "ap" action points, "mp" movement
  points, "portee" the range bonus already added to the spells below, "heldBy" the
  enemies standing next to it.
- "enemies" and "allies": every fighter. "n" is the short number to think in.
  "hp"/"maxHp"/"hpPercent" is what they have left, "distance" how far, "los" whether
  there is a clear line to them, "reach" how far they can move plus hit next turn,
  "resists" the percentage they resist each element.
- "spells": what the character owns. "ap" cost, "range" as min-max, "area" the shape
  it covers, "cooldown", "castsLeft", "mastery" whether it is a mastery, "blocked" the
  reason it cannot be cast this turn, and "damage" what it would really take off each
  enemy by short number — resistances already applied.
- "casts": EVERY legal cast from where the character stands right now. Each has a key
  "k", the "spell", the "cell" it is aimed at, its "ap" cost, "hits" (the enemies its
  area covers), "friendly" (allies caught in it), "damage", "kills", and "value".
- "moves": every worthwhile cell to walk to, with "mp" the cost, "distance" to the
  closest monster from there, "threats" how many monsters could reach that cell next
  turn, and "casts": the casts that become possible once standing there.

HOW TO ANSWER
Answer with JSON and nothing else:
{"plan":["c1","c3"],"why":"short reason"}
"plan" is an ordered list of keys taken from "casts" and "moves" — never anything else.
Rules the answer must respect:
- at most one move, and it must come first
- after a move "m2", only the casts listed inside "m2" may be used ("m2c1", "m2c2"...)
- with no move, only the top-level casts ("c1", "c2"...) may be used
- the action points spent must not exceed "me.ap"
- when "me.canMove" is false the character is held: plan no move at all
- an empty plan is only right when both "casts" and every move's "casts" are empty

HOW TO CHOOSE, IN THIS ORDER
1. Kill. A cast whose "kills" is not empty is almost always the right one: a dead
   monster stops playing, which is worth more than any damage.
2. Hit as many as possible. Between two casts of similar damage, take the one whose
   "hits" is longer. Area spells are aimed at a cell, not at a monster, and the cell
   beside a monster often covers two or three of them.
3. Keep the mastery up. A spell with "mastery":true and "cooldown":"ready" is cast
   FIRST, as long as the action points left after it still pay for an attack. It lasts
   several turns; the arrow it delays is thrown a moment later, harder or further.
4. Spend every action point. A turn that ends with points unspent is a wasted turn.
   Prefer two cheap casts to one expensive one when they total more damage.
5. Finish the wounded. Short of a kill, aim at the lowest "hpPercent".
6. Stand well. Prefer a move whose "threats" is 0 and whose "distance" is large: a
   monster that cannot walk up to the character cannot hit it either. Never move for
   distance alone when it costs the casts — the casts come first.
7. Never choose a cast whose "friendly" list is not empty unless nothing else hits.

WORKED EXAMPLE
Given casts c1 (2 AP, hits [1], damage 40), c2 (4 AP, hits [1,2], damage 90, kills [2])
and 6 action points, the answer is {"plan":["c2","c1"],"why":"kill 2, then hit 1"} —
c2 first because it kills, c1 after because two points would otherwise be wasted.`

export interface ModelMove {
  type: 'move'
  cellId: number
  cost: number
}

export interface ModelCast {
  type: 'cast'
  spellId: number
  name: string
  cellId: number
  apCost: number
  hits: number[]
}

export type ModelAction = ModelMove | ModelCast

export interface ModelAnswer {
  plan: string[]
  reason?: string
}

export interface ResolvedPlan {
  actions: ModelAction[]
  rejected: string[]
  reason?: string
  /** The plan attacked nobody although something was in reach. */
  castsNothing: boolean
}

/** How much of the fight is written out, for the log and the tests. */
export function buildPrompt(snapshot: CombatSnapshot, preferChallenges: boolean): string {
  const challenges =
    preferChallenges && snapshot.challenges.length > 0
      ? `\nThe fight runs these challenges — favour them when it costs nothing:\n${snapshot.challenges
          .map((challenge) => `- ${challenge.name}${challenge.description ? ` — ${challenge.description}` : ''}`)
          .join('\n')}\n`
      : ''

  const notes = snapshot.notes.length > 0 ? `\nNotes:\n${snapshot.notes.map((note) => `- ${note}`).join('\n')}\n` : ''

  return `Fight state:\n${JSON.stringify(snapshot)}\n${notes}${challenges}\nAnswer with the JSON plan for turn ${snapshot.turn}.`
}

/**
 * Parses the answer, tolerating the prose a small model wraps it in.
 *
 * Both shapes are accepted: the keys this prompt asks for, and the older
 * {"actions":[{"type":"cast","spellId":..}]} a model trained on the previous
 * prompt still produces. A usable turn is worth more than a tidy contract.
 */
export function parseModelAnswer(raw: string): ModelAnswer | null {
  const text = raw.trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }

  const reason =
    typeof parsed.why === 'string'
      ? parsed.why.slice(0, 200)
      : typeof parsed.reason === 'string'
        ? parsed.reason.slice(0, 200)
        : undefined

  if (Array.isArray(parsed.plan)) {
    return {
      plan: parsed.plan.filter((key): key is string => typeof key === 'string').map((key) => key.trim()),
      reason
    }
  }

  // The older shape: actions naming spells and targets. Their keys are found
  // by matching the spell, which is what the caller resolves against anyway.
  if (Array.isArray(parsed.actions)) {
    const plan: string[] = []
    for (const action of parsed.actions) {
      if (!action || typeof action !== 'object') continue
      const entry = action as Record<string, unknown>
      if (entry.type === 'move' && typeof entry.cellId === 'number') plan.push(`cell:${entry.cellId}`)
      if (entry.type === 'cast' && typeof entry.spellId === 'number') plan.push(`spell:${entry.spellId}`)
    }
    return { plan, reason }
  }

  return null
}

function castsOf(snapshot: CombatSnapshot, moveKey: string | null): SnapshotCast[] {
  if (moveKey === null) return snapshot.casts
  return snapshot.moves.find((move) => move.k === moveKey)?.casts ?? []
}

/**
 * Turns an answer into actions the fight will accept, and says what it dropped.
 *
 * Every key is checked against the snapshot it came from: a cast that is not
 * on the list, a second move, a spell the points no longer pay for. What is
 * left is legal by construction — the cells were computed here, not there.
 */
export function resolvePlan(snapshot: CombatSnapshot, answer: ModelAnswer): ResolvedPlan {
  const actions: ModelAction[] = []
  const rejected: string[] = []

  let moveKey: string | null = null
  let apLeft = snapshot.me.ap
  const used = new Map<number, number>()

  for (const raw of answer.plan) {
    const key = raw.trim()
    if (key.length === 0) continue

    // The older shape names a cell rather than a key; it still has to be one
    // of the cells the snapshot offered.
    const move = key.startsWith('cell:')
      ? snapshot.moves.find((candidate) => candidate.cell === Number(key.slice(5)))
      : snapshot.moves.find((candidate) => candidate.k === key)

    if (!move && key.startsWith('cell:')) {
      rejected.push(`${key}: not a cell this turn can move to`)
      continue
    }

    if (move) {
      if (moveKey !== null) {
        rejected.push(`${key}: only one move a turn`)
        continue
      }
      if (actions.length > 0) {
        rejected.push(`${key}: a move must come before the casts`)
        continue
      }
      if (!snapshot.me.canMove) {
        rejected.push(`${key}: held in contact, moving is tackled`)
        continue
      }
      moveKey = move.k
      actions.push({ type: 'move', cellId: move.cell, cost: move.mp })
      continue
    }

    // The older shape names a spell rather than a key: take the best cast the
    // snapshot offers for it. A cast is too valuable to drop over a format.
    const available = castsOf(snapshot, moveKey)
    let cast = available.find((candidate) => candidate.k === key)

    if (!cast && key.startsWith('spell:')) {
      const spellId = Number(key.slice(6))
      cast = available.find((candidate) => candidate.spell === spellId)
      if (!cast) {
        rejected.push(`spell ${spellId}: nothing it can reach from there`)
        continue
      }
    }

    if (!cast && key.startsWith('cell:')) {
      rejected.push(`${key}: not a cell this turn can move to`)
      continue
    }

    if (!cast) {
      const elsewhere =
        snapshot.casts.some((candidate) => candidate.k === key) ||
        snapshot.moves.some((entry) => entry.casts.some((candidate) => candidate.k === key))
      rejected.push(
        elsewhere ? `${key}: that cast belongs to another position` : `${key}: not an option`
      )
      continue
    }

    if (cast.ap > apLeft) {
      rejected.push(`${cast.name}: ${cast.ap} AP with ${apLeft} left`)
      continue
    }

    // The limit belongs to the spell, not to the cell it is thrown at: two
    // different aim cells are still two casts of the same spell.
    const spell = snapshot.spells.find((candidate) => candidate.id === cast.spell)
    const alreadyCast = used.get(cast.spell) ?? 0
    if (spell?.castsLeft !== null && spell?.castsLeft !== undefined && alreadyCast >= spell.castsLeft) {
      rejected.push(`${cast.name}: already cast ${alreadyCast} time(s) this turn`)
      continue
    }

    used.set(cast.spell, alreadyCast + 1)
    apLeft -= cast.ap
    actions.push({
      type: 'cast',
      spellId: cast.spell,
      name: cast.name,
      cellId: cast.cell,
      apCost: cast.ap,
      hits: cast.hits
    })
  }

  const somethingWasPossible =
    snapshot.casts.length > 0 || snapshot.moves.some((move) => move.casts.length > 0)

  return {
    actions,
    rejected,
    reason: answer.reason,
    castsNothing: somethingWasPossible && !actions.some((action) => action.type === 'cast')
  }
}
