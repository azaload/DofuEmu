import type { CombatElement } from '@dofemu/shared'
import type { DofusWindow } from '@/types/dofus-window'
import type { SpellDetails } from '../spell-catalogue'
import { readBattlefield, type Battlefield, type Combatant } from './battlefield'
import { readSpellbook, explain, type Spellbook, type SpellState } from './spellbook'
import { aimCandidates, effectiveRange, type AimContext } from './aiming'
import {
  applyCast,
  castsLeft,
  damageTo,
  distanceToEnemies,
  scoreCast,
  threatCount,
  type PlanState,
  type ScoreContext,
  type ScoredCast
} from './evaluate'
import { cellDistance, type Grid } from './geometry'

/**
 * The turn, decided in one place: where to stand, what to throw, in what
 * order.
 *
 * At every step the planner compares the best run of casts it can make where
 * it stands against what a step sideways would unlock, and does whichever is
 * worth more. So the movement points may be spent before the first spell,
 * between two of them, or not at all — whatever the turn is worth the most.
 *
 * It weighs runs, not single casts, because the best next cast is often the
 * wrong one: with four action points, a four-point spell worth forty loses to
 * two two-point spells worth sixty together.
 */

export interface PlannedCast {
  spellId: number
  name: string | null
  cellId: number
  /** Fighter ids the area lands on. */
  hits: number[]
  /** Allies, or ourselves, caught in the same area. */
  friendlyHits: number[]
  apCost: number
  value: number
  reason: string
}

export interface PlannedMove {
  type: 'move'
  cellId: number
  path: number[]
  cost: number
  reason: string
}

export interface PlannedSpell extends PlannedCast {
  type: 'cast'
}

export type PlannedAction = PlannedMove | PlannedSpell

export interface TurnPlan {
  /** Moves and casts, in the order they should be played. */
  actions: PlannedAction[]
  casts: PlannedCast[]
  value: number
  /** Why the plan is empty, when it is. Never a silent nothing. */
  diagnostic: string | null
  /** Why each spell that was left out stayed out, for the activity log. */
  leftOut: string[]
  /**
   * What the turn noticed about the fight itself, rather than about a spell:
   * a monster nothing can hurt, a summon left alone. Worth saying once.
   */
  notes: string[]
}

export interface PlanContext {
  turn: number
  /** `spellId:cellId` the server has already refused this turn. */
  blockedCasts?: ReadonlySet<string>
  /** Fighters the fight has announced dead, whatever the client still says. */
  ignoreFighters?: ReadonlySet<number>
  /** Casts already played this turn, per spell, across the re-plans. */
  castsThisTurn?: ReadonlyMap<number, number>
  /**
   * Casts already played this turn on each fighter, keyed `spellId:fighterId`.
   *
   * The turn is re-planned after every action, so a plan that starts with an
   * empty record aims the same spell at the same monster again and again —
   * and the server refuses it, silently, for a limit the plan had forgotten.
   */
  castsPerTarget?: ReadonlyMap<string, number>
  /**
   * What a spell really costs this turn, when it is not what the book says.
   *
   * Some spells grow with use — each cast in the same turn costs a point more
   * than the last. The book gives the first price only, so the turn learns
   * the rest from what the game accepts and passes it back here.
   */
  apCosts?: ReadonlyMap<number, number>
  actionPoints: number
  movementPoints: number
  elements: CombatElement[]
  /** Spell id to the turn it was last cast on. */
  lastCastTurn: ReadonlyMap<number, number>
  /** Moving is off the table: held in contact, or a challenge forbids it. */
  canMove: boolean
  /** Prefer standing away from the enemies once the casting is decided. */
  keepDistance: boolean
  /** Put the mastery back up whenever its cooldown and the points allow. */
  keepMasteryUp?: boolean
  /**
   * Only aim at a summon when no other enemy is in reach.
   *
   * "In reach" means from the cell being considered: a summon standing in
   * front of a monster the character can also hit is left alone, and one
   * standing alone in front of a character that can reach nothing else is
   * shot, because a turn spent casting nothing is worse.
   */
  summonsLast?: boolean
  /** A grid to share across the turn, so its caches are not rebuilt. */
  grid?: Grid
}

/** How much a step is charged, so a move has to earn its points. */
const MOVE_COST_PENALTY = 0.5
/**
 * What a cell of distance is worth beside the damage of a cast.
 *
 * Ending the fight is the point; standing further back only helps until it
 * starts costing hits. Kept small deliberately: a better cast from closer in
 * has to win, or the character spends the fight backing away from spells it
 * could have thrown.
 */
const DISTANCE_BONUS = 1.5
/** Weight of getting closer when no cast is possible from anywhere. */
const APPROACH_WEIGHT = 10
/** What each monster that could reach us next turn costs a cell. */
const THREAT_PENALTY = 12
/** And what ending a turn inside a monster's arms costs on top. */
const CONTACT_PENALTY = 45
/** Actions a single turn may plan. */
const MAX_STEPS = 14
/** Casts examined at each step of the sequence search. */
const BRANCHES = 4
/**
 * Casts a single sequence may chain.
 *
 * Bounded by the action points in practice — twelve points and a two-point
 * spell is six casts — and by this only so that a turn with a great many
 * cheap casts cannot run the search away.
 */
const MAX_DEPTH = 8
/** The same, for the cheaper search that only compares two positions. */
const SCOUT_BRANCHES = 2
const SCOUT_DEPTH = 3
/**
 * Aim cells kept per spell before they are scored.
 *
 * They arrive ordered by how many fighters the area covers, which says
 * nothing about what a cast sets up: the cell that pulls a pack together
 * covers one monster like a dozen others do. Keeping too few is how that cell
 * gets cut before anything has looked at it.
 */
const AIM_LIMIT = 8
/**
 * Nodes a single search may open.
 *
 * A turn planned slowly is a turn played late, and the client times out on a
 * fighter that does nothing. The budget bounds the worst case; what is found
 * when it runs out is still a legal, usually optimal, turn.
 */
const NODE_BUDGET = 20000
/** Positions compared before a move. Beyond this the extra cells buy nothing. */
const MAX_POSITIONS = 44

interface Search {
  nodes: number
}

function aimContext(state: PlanState, grid: Grid): AimContext {
  return {
    grid,
    rangeBonus: state.rangeBonus,
    occupied: state.occupied,
    enemies: state.enemies,
    friends: state.friends
  }
}

/**
 * Every cast worth considering from a position, best value first.
 *
 * A mastery is always among them when it is available: it is the one cast a
 * turn must not forget, and pruning it on immediate value alone is exactly
 * how it gets forgotten.
 */
function candidateCasts(
  from: number,
  book: Spellbook,
  state: PlanState,
  context: ScoreContext,
  plan: PlanContext,
  limit: number
): ScoredCast[] {
  const aim = aimContext(state, context.grid)

  const scoredOf = (entry: SpellState): ScoredCast[] => {
    const spell = entry.spell
    if (!castsLeft(spell, state)) return []
    if (entry.apCost > state.actionPoints) return []

    const against =
      spell.kind === 'heal'
        ? state.friends.filter((friend) => friend.life < friend.maxLife)
        : spell.kind === 'boost'
          ? state.friends.filter((friend) => friend.cellId === from)
          : state.enemies

    const scored: ScoredCast[] = []
    for (const candidate of aimCandidates(aim, spell, from, against, AIM_LIMIT)) {
      // Asking a second time for what the server has just refused wastes the
      // turn on the same answer.
      if (plan.blockedCasts?.has(`${spell.id}:${candidate.cellId}`)) continue
      const cast = scoreCast(candidate, entry.apCost, state, context)
      if (cast) scored.push(cast)
    }
    return scored
  }

  const highest = (casts: ScoredCast[]): ScoredCast | null =>
    casts.reduce<ScoredCast | null>(
      (best, cast) => (!best || cast.value > best.value ? cast : best),
      null
    )

  /**
   * The summon rule, applied across every spell at once.
   *
   * It has to be one decision for the whole position, not one per spell: with
   * a real monster in reach of the bow and only a summon in reach of the
   * short-range spell, the short-range spell must go unused rather than spend
   * the turn on the summon.
   */
  const withSummonRule = (perSpell: Map<number, ScoredCast[]>): Map<number, ScoredCast[]> => {
    if (plan.summonsLast === false) return perSpell

    const touchesReal = (cast: ScoredCast) =>
      cast.candidate.enemies.some((enemy) => !enemy.summoned)

    let anyReal = false
    for (const casts of perSpell.values()) {
      if (casts.some(touchesReal)) {
        anyReal = true
        break
      }
    }
    if (!anyReal) return perSpell

    // A summon is an obstacle that can be moved, so a spell that shoves it is
    // never dropped by this rule: pushing one out of a line, or off the cell
    // it is holding us on, is not the same as spending the turn killing it.
    // What it does to the summon on the way is discounted to almost nothing,
    // so such a cast only wins when the shove itself is worth something.
    const shoves = (cast: ScoredCast) =>
      cast.spell.pushDistance > 0 || cast.spell.pullDistance > 0

    const kept = new Map<number, ScoredCast[]>()
    for (const [id, casts] of perSpell) {
      // A cast touching no enemy at all is a buff or a heal: the rule says
      // nothing about those.
      kept.set(
        id,
        casts.filter(
          (cast) => cast.candidate.enemies.length === 0 || touchesReal(cast) || shoves(cast)
        )
      )
    }
    return kept
  }

  /**
   * A boost comes before any single hit.
   *
   * Not because it scores higher — one arrow off a five-thousand-life boss
   * scores higher than any buff — but because it lasts several turns and the
   * arrow does not. The adaptation to the points available is in `scoreCast`:
   * a boost that would leave too few points to attack with scores nothing at
   * all, and never reaches this list.
   *
   * Masteries first among them: a range or damage buff changes what every
   * cast after it can reach and take off.
   */
  if (plan.keepMasteryUp !== false) {
    const boosts = book.usable.filter((entry) => entry.spell.kind === 'boost')
    for (const entry of [...boosts].sort((a, b) => Number(b.spell.isMastery) - Number(a.spell.isMastery))) {
      const candidate = highest(scoredOf(entry))
      if (candidate) return [candidate]
    }
  }

  const perSpell = new Map<number, ScoredCast[]>()
  for (const entry of book.usable) perSpell.set(entry.spell.id, scoredOf(entry))

  const found: ScoredCast[] = []
  for (const casts of withSummonRule(perSpell).values()) {
    const best = highest(casts)
    if (best) found.push(best)
  }

  /**
   * The branches worth opening.
   *
   * Ranking by value alone is what loses a turn: with twelve action points, a
   * two-point arrow that may be thrown three times beats a six-point one
   * thrown twice, and the cheap arrow never makes the top of a list sorted by
   * what each cast is worth on its own. So the most efficient cast — the one
   * that buys the most per action point — is always opened as well, even when
   * it looks small beside the rest.
   */
  found.sort((a, b) => b.value - a.value)
  const kept = found.slice(0, limit)

  const perPoint = (cast: ScoredCast) => cast.value / Math.max(1, cast.apCost)
  const efficient = found.reduce<ScoredCast | null>(
    (best, cast) => (!best || perPoint(cast) > perPoint(best) ? cast : best),
    null
  )
  if (efficient && !kept.includes(efficient)) kept.push(efficient)

  return kept
}

/**
 * The best run of casts from a position, not merely the best next one.
 *
 * Ties are broken towards the sequence that opens with a boost: a mastery put
 * up now lasts several turns, and the arrow it delays is thrown a moment
 * later at a target that takes more from it.
 */
function bestSequenceFrom(
  from: number,
  book: Spellbook,
  state: PlanState,
  context: ScoreContext,
  plan: PlanContext,
  search: Search,
  depth: number,
  branches: number
): { casts: ScoredCast[]; value: number } {
  if (depth <= 0 || state.actionPoints <= 0) return { casts: [], value: 0 }
  if (search.nodes >= NODE_BUDGET) return { casts: [], value: 0 }
  search.nodes += 1

  const candidates = candidateCasts(from, book, state, context, plan, branches)
  if (candidates.length === 0) return { casts: [], value: 0 }

  let best: { casts: ScoredCast[]; value: number } = { casts: [], value: 0 }
  let bestOpensWithBoost = false

  for (const candidate of candidates) {
    const rest = bestSequenceFrom(
      from,
      book,
      applyCast(state, candidate, context),
      context,
      plan,
      search,
      depth - 1,
      branches
    )

    const total = candidate.value + rest.value
    const opensWithBoost = candidate.spell.kind === 'boost'
    const better =
      total > best.value ||
      (total === best.value && opensWithBoost && !bestOpensWithBoost)

    if (better) {
      best = { casts: [candidate, ...rest.casts], value: total }
      bestOpensWithBoost = opensWithBoost
    }
  }

  return best
}

function toPlannedCast(cast: ScoredCast): PlannedSpell {
  return {
    type: 'cast',
    spellId: cast.spell.id,
    name: cast.spell.name,
    cellId: cast.candidate.cellId,
    hits: cast.candidate.enemies.map((enemy) => enemy.id),
    friendlyHits: cast.candidate.friends.map((friend) => friend.id),
    apCost: cast.apCost,
    value: cast.value,
    reason: cast.reason
  }
}

/**
 * How far apart two monsters may stand and still be caught by one cast.
 *
 * Twice the widest area, not once: a cross of one reaches a cell either side
 * of where it lands, so two monsters two cells apart are both covered by the
 * cell between them. Measuring the radius instead of the span is what made a
 * pull that brought a pack into range look like it had achieved nothing.
 */
function groupingRadius(book: Spellbook): number {
  const widest = book.usable
    .filter((entry) => entry.spell.kind === 'damage')
    .reduce((most, entry) => Math.max(most, entry.spell.zone.size), 0)
  return widest * 2
}

/** The reach the character fights at: the longest attack it can still throw. */
function ownReachOf(book: Spellbook, state: PlanState): number {
  const ranges = book.usable
    .filter((entry) => entry.spell.kind === 'damage')
    .map((entry) => effectiveRange(entry.spell, state.rangeBonus))
  return ranges.length > 0 ? Math.max(...ranges) : 1
}

/**
 * What standing on a cell is worth.
 *
 * Keeping away only counts when a spell can actually be cast from there. With
 * nothing in reach the character must close in instead — otherwise it backs
 * away from a fight it cannot start and ends up in a corner, which is exactly
 * what it used to do.
 */
function positionValue(
  cellId: number,
  castValue: number,
  state: PlanState,
  plan: PlanContext,
  ownReach: number
): number {
  const distance = distanceToEnemies(cellId, state.enemies)
  if (distance < 0) return castValue

  if (castValue > 0) {
    if (!plan.keepDistance) return castValue
    return (
      castValue +
      distance * DISTANCE_BONUS -
      threatCount(cellId, state.enemies) * THREAT_PENALTY -
      (distance <= 1 ? CONTACT_PENALTY : 0)
    )
  }

  // Nothing can be cast from anywhere in reach. Closing in is right; closing
  // all the way is not — a ranged character that ends its turn in contact
  // spends the next one tackled. The cell wanted is the edge of our range.
  if (plan.keepDistance) return -Math.abs(distance - ownReach) * APPROACH_WEIGHT
  return -distance * APPROACH_WEIGHT
}

/**
 * The cells worth comparing before a move.
 *
 * With six movement points a character can reach a hundred cells, and running
 * a cast search from each of them costs more than the turn is worth. The ones
 * kept are the ones a ranged character would look at: somewhere it can shoot
 * from, as far back as its own range allows.
 */
function candidatePositions(
  field: Battlefield,
  state: PlanState,
  plan: PlanContext,
  position: number,
  movementPoints: number,
  book: Spellbook
): Array<{ cellId: number; path: number[]; cost: number }> {
  const blocked = new Set([...state.occupied].filter((cellId) => cellId !== position))
  const reachable = [...field.grid.reachable(position, movementPoints, blocked).values()].filter(
    (entry) => entry.cellId !== position && !state.occupied.has(entry.cellId)
  )
  if (reachable.length <= MAX_POSITIONS) return reachable

  const reach = ownReachOf(book, state)
  const scored = reachable.map((entry) => {
    const distance = distanceToEnemies(entry.cellId, state.enemies)
    const sees = state.enemies.filter(
      (enemy) =>
        cellDistance(entry.cellId, enemy.cellId) <= reach &&
        field.grid.sees(entry.cellId, enemy.cellId)
    ).length
    return { entry, sees, distance, threats: threatCount(entry.cellId, state.enemies) }
  })

  scored.sort((a, b) => {
    if ((a.sees > 0) !== (b.sees > 0)) return a.sees > 0 ? -1 : 1
    if (plan.keepDistance && a.threats !== b.threats) return a.threats - b.threats
    if (a.distance !== b.distance) return plan.keepDistance ? b.distance - a.distance : a.distance - b.distance
    return a.entry.cost - b.entry.cost
  })

  return scored.slice(0, MAX_POSITIONS).map((entry) => entry.entry)
}

/**
 * The last thing a turn does: get out of reach.
 *
 * Movement points left over are worth nothing kept. Spent backing away they
 * decide how much of the monsters' turn lands: one that cannot walk up to the
 * character cannot hit it either. Cells are scored by how many enemies could
 * still reach them, using the movement each one really has, then by plain
 * distance — but never past our own range, since leaving the fight only
 * postpones it.
 */
function planRetreat(
  field: Battlefield,
  state: PlanState,
  plan: PlanContext,
  position: number,
  movementPoints: number,
  ownReach: number
): PlannedMove | null {
  if (movementPoints <= 0 || !plan.keepDistance || state.enemies.length === 0) return null

  const blocked = new Set([...state.occupied].filter((cellId) => cellId !== position))
  const here = {
    threats: threatCount(position, state.enemies),
    distance: distanceToEnemies(position, state.enemies)
  }

  let best: { cellId: number; path: number[]; cost: number; threats: number; distance: number } | null =
    null

  for (const entry of field.grid.reachable(position, movementPoints, blocked).values()) {
    if (entry.cellId === position || state.occupied.has(entry.cellId)) continue

    const distance = distanceToEnemies(entry.cellId, state.enemies)
    // Out of our own reach is not safety, it is leaving the fight: the next
    // turn would open with a walk instead of a cast.
    if (distance > ownReach) continue
    // And never step into another monster's arms for the sake of one cell.
    if (distance <= 1 && here.distance > 1) continue

    const threats = threatCount(entry.cellId, state.enemies)
    const better = threats !== here.threats ? threats < here.threats : distance > here.distance
    if (!better) continue

    if (!best || threats < best.threats || (threats === best.threats && distance > best.distance)) {
      best = { cellId: entry.cellId, path: entry.path, cost: entry.cost, threats, distance }
    }
  }

  if (!best) return null

  return {
    type: 'move',
    cellId: best.cellId,
    path: best.path,
    cost: best.cost,
    reason:
      best.threats < here.threats
        ? `out of reach of ${here.threats - best.threats} monster(s) next turn`
        : `${best.distance} cell(s) from the closest monster`
  }
}

/** Why a spell the character owns was not cast this turn. */
function leftOutReasons(
  book: Spellbook,
  state: PlanState,
  plan: PlanContext,
  position: number,
  castIds: Set<number>,
  context: ScoreContext
): string[] {
  const reasons: string[] = []
  const aim = aimContext(state, context.grid)

  for (const entry of book.states) {
    if (castIds.has(entry.spell.id)) continue
    const name = entry.spell.name ?? `spell ${entry.spell.id}`

    if (!entry.usable) {
      reasons.push(explain(entry, state.actionPoints, plan.elements))
      continue
    }

    if (entry.spell.kind === 'damage') {
      const options = aimCandidates(aim, entry.spell, position, state.enemies, 4)

      // A spell that can only reach a summon while something else is being
      // shot is the one case where "worth less than what was cast" would be a
      // lie: it was not weighed at all.
      if (
        plan.summonsLast !== false &&
        options.length > 0 &&
        options.every((option) => option.enemies.every((enemy) => enemy.summoned))
      ) {
        reasons.push(`${name}: only a summon in reach, and summons are left for last`)
        continue
      }

      // Everything it can reach shrugs it off entirely — the invulnerable
      // state, or a resistance that swallows the whole hit.
      if (
        options.length > 0 &&
        options.every((option) =>
          option.enemies.every((enemy) => damageTo(entry.spell, enemy, context.profile) <= 0)
        )
      ) {
        reasons.push(`${name}: everything in its reach takes nothing from it`)
        continue
      }

      if (options.length === 0) {
        const closest = distanceToEnemies(position, state.enemies)
        reasons.push(
          `${name}: nothing in its ${entry.spell.minRange}-${effectiveRange(
            entry.spell,
            state.rangeBonus
          )}${entry.spell.castInLine ? ' straight-line' : ''} reach (closest enemy ${closest})`
        )
        continue
      }
    }

    reasons.push(`${name}: worth less than what was cast`)
  }

  return reasons
}

export function planTurn(gameWindow: DofusWindow, plan: PlanContext): TurnPlan | null {
  const field = readBattlefield(gameWindow, {
    turn: plan.turn,
    ignore: plan.ignoreFighters,
    grid: plan.grid
  })
  if (!field) return null

  const empty = (diagnostic: string): TurnPlan => ({
    actions: [],
    casts: [],
    value: 0,
    diagnostic,
    leftOut: [],
    notes: []
  })

  const book = readSpellbook(gameWindow, {
    turn: plan.turn,
    elements: plan.elements,
    lastCastTurn: plan.lastCastTurn,
    castsThisTurn: plan.castsThisTurn,
    apCosts: plan.apCosts,
    actionPoints: plan.actionPoints
  })

  if (book.all.length === 0) return empty('the spellbook could not be read from this client')
  if (book.usable.length === 0) {
    const why = book.states.map((entry) => entry.reason)
    if (why.every((reason) => reason === 'element')) {
      return empty(
        `every spell is filtered out by the chosen elements (${plan.elements.join(', ') || 'none'})`
      )
    }
    if (why.every((reason) => reason === 'cooldown')) return empty('every spell is still on cooldown')
    if (why.some((reason) => reason === 'action-points')) {
      return empty(`no spell costs ${plan.actionPoints} action point(s) or less`)
    }
    return empty('no spell can be cast from what this client exposes')
  }
  if (field.enemies.length === 0) return empty('no enemy left to aim at')

  const friends = [field.me, ...field.allies]

  let state: PlanState = {
    actionPoints: plan.actionPoints,
    movementPoints: plan.canMove ? plan.movementPoints : 0,
    enemies: field.enemies.map((enemy) => ({ ...enemy })),
    friends: friends.map((friend) => ({ ...friend })),
    occupied: new Set(field.occupied),
    castsThisTurn: new Map(plan.castsThisTurn ?? []),
    castsPerTarget: new Map(plan.castsPerTarget ?? []),
    rangeBonus: 0,
    powerBonus: 0,
    buffsUp: new Set()
  }

  // Everything alive is expected to die this turn: a buff would be wasted on
  // a fight that is already over.
  const totalLife = state.enemies.reduce((total, enemy) => total + enemy.life, 0)
  const cheapest = Math.max(1, Math.min(...book.usable.map((entry) => entry.apCost || 1)))
  const bestHit = Math.max(
    0,
    ...book.attacks.flatMap((entry) =>
      state.enemies.map((enemy) =>
        scoreCast(
          { spell: entry.spell, from: field.me.cellId, cellId: enemy.cellId, covered: [enemy.cellId], enemies: [enemy], friends: [], hitsSelf: false },
          entry.apCost,
          state,
          {
            profile: field.profile,
            grid: field.grid,
            fightEndsThisTurn: false,
            cheapestAttack: 0,
            keepDistance: plan.keepDistance,
            summonsLast: plan.summonsLast !== false,
            heldBy: new Set<number>(),
            groupRadius: 0
          }
        )?.damage.get(enemy.id) ?? 0
      )
    )
  )

  const context: ScoreContext = {
    profile: field.profile,
    grid: field.grid,
    fightEndsThisTurn:
      totalLife > 0 && bestHit * Math.floor(plan.actionPoints / cheapest) >= totalLife,
    cheapestAttack: book.cheapestAttack,
    keepDistance: plan.keepDistance,
    summonsLast: plan.summonsLast !== false,
    // Whoever is standing on us right now: those are the holds worth paying a
    // cast to break, and no others.
    heldBy: new Set(
      field.enemies
        .filter((enemy) => cellDistance(field.me.cellId, enemy.cellId) === 1)
        .map((enemy) => enemy.id)
    ),
    groupRadius: groupingRadius(book)
  }

  /**
   * Monsters nothing in the book can take a point off.
   *
   * The invulnerable state is a flat reduction of several thousand, so it
   * shows up here as every spell dealing zero — no state table to keep up to
   * date, and it clears itself the moment the reduction expires.
   */
  const notes: string[] = []
  if (book.attacks.length > 0) {
    const untouchable = state.enemies.filter((enemy) =>
      book.attacks.every((entry) => damageTo(entry.spell, enemy, field.profile) <= 0)
    )
    if (untouchable.length > 0 && untouchable.length < state.enemies.length) {
      notes.push(
        `${untouchable.map((enemy) => enemy.name).join(', ')} takes nothing from any spell ` +
          '(invulnerable): aiming at the others while it lasts'
      )
    } else if (untouchable.length === state.enemies.length) {
      notes.push(
        `every enemy takes nothing from any spell (invulnerable): casting anyway, ` +
          'the points are worth nothing kept'
      )
    }
  }

  const actions: PlannedAction[] = []
  const casts: PlannedCast[] = []
  let position = field.me.cellId
  let movementPoints = state.movementPoints
  let total = 0

  for (let step = 0; step < MAX_STEPS; step++) {
    const search: Search = { nodes: 0 }
    // As many casts as the points could possibly pay for, capped.
    const cheapest = Math.max(1, Math.min(...book.usable.map((entry) => entry.apCost || 1)))
    const depth = Math.max(1, Math.min(MAX_DEPTH, Math.ceil(state.actionPoints / cheapest)))

    const here = bestSequenceFrom(position, book, state, context, plan, search, depth, BRANCHES)
    const ownReach = ownReachOf(book, state)

    let move:
      | { cellId: number; path: number[]; cost: number; gain: number; opening: ScoredCast | null }
      | null = null

    if (movementPoints > 0) {
      const currentValue = positionValue(position, here.value, state, plan, ownReach)
      const scout: Search = { nodes: 0 }

      for (const entry of candidatePositions(field, state, plan, position, movementPoints, book)) {
        const there = { ...state, occupied: new Set(state.occupied) }
        there.occupied.delete(position)
        there.occupied.add(entry.cellId)

        const cast = bestSequenceFrom(
          entry.cellId,
          book,
          there,
          context,
          plan,
          scout,
          SCOUT_DEPTH,
          SCOUT_BRANCHES
        )
        const gain =
          positionValue(entry.cellId, cast.value, there, plan, ownReach) -
          currentValue -
          entry.cost * MOVE_COST_PENALTY

        if (gain > 0 && (!move || gain > move.gain)) {
          move = {
            cellId: entry.cellId,
            path: entry.path,
            cost: entry.cost,
            gain,
            opening: cast.casts[0] ?? null
          }
        }
      }
    }

    if (move) {
      actions.push({
        type: 'move',
        cellId: move.cellId,
        path: move.path,
        cost: move.cost,
        reason: move.opening
          ? `to cast ${move.opening.spell.name ?? move.opening.spell.id} on ${move.opening.reason}`
          : `${distanceToEnemies(move.cellId, state.enemies)} cell(s) from the closest enemy`
      })
      state = { ...state, occupied: new Set(state.occupied) }
      state.occupied.delete(position)
      state.occupied.add(move.cellId)
      state.friends = state.friends.map((friend) =>
        friend.side === 'me' ? { ...friend, cellId: move!.cellId } : friend
      )
      position = move.cellId
      movementPoints -= move.cost
      total += move.gain
      continue
    }

    const next = here.casts[0]
    if (!next) break

    actions.push(toPlannedCast(next))
    casts.push(toPlannedCast(next))
    total += next.value
    state = applyCast(state, next, context)
    movementPoints += next.spell.mpGain

    if (state.actionPoints <= 0 || state.enemies.length === 0) break
  }

  const retreat = planRetreat(field, state, plan, position, movementPoints, ownReachOf(book, state))
  if (retreat) {
    actions.push(retreat)
    movementPoints -= retreat.cost
    position = retreat.cellId
  }

  const castIds = new Set(casts.map((cast) => cast.spellId))
  const atEnd = { ...state, occupied: new Set(state.occupied) }
  atEnd.occupied.delete(field.me.cellId)
  atEnd.occupied.add(position)

  return {
    actions,
    casts,
    value: total,
    leftOut: leftOutReasons(book, atEnd, plan, position, castIds, context),
    notes,
    diagnostic:
      actions.length === 0
        ? 'no cell brings an enemy within reach of a spell that is worth casting' +
          ` (closest enemy ${distanceToEnemies(position, state.enemies)} cell(s) away, longest range ${Math.max(
            0,
            ...book.usable.map((entry) => entry.spell.range)
          )})` + unreadableNote(book)
        : null
  }
}

function unreadableNote(book: Spellbook): string {
  const unreadable = book.states.filter((entry) => entry.reason === 'unreadable')
  if (unreadable.length === 0) return ''
  return ` (${unreadable.length} spell(s) left out, effects not recognised: ${unreadable
    .map((entry) => entry.spell.name ?? entry.spell.id)
    .join(', ')})`
}

