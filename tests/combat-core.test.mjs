import assert from 'assert'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { build } from 'vite'

/**
 * The combat core, hammered.
 *
 * Every layer is checked against an independent answer rather than against
 * itself: the range bands against a sweep of all 560 cells, the aiming
 * against an exhaustive search of every legal cell, the placement against a
 * reference walk of the first turn, the planner against a referee that
 * refuses what the game would refuse.
 *
 * All of it runs over generated fights — hundreds of them, from a seeded
 * generator, so a failure is reproducible from the seed it prints.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const tmpDir = path.join(root, 'tests/.tmp-core')

const SEED = Number(process.env.COMBAT_SEED ?? 20260901)

async function bundleModule(entry, name) {
  // Vite names the bundle after the entry file, not after what we ask for.
  await build({
    configFile: false,
    logLevel: 'error',
    resolve: {
      alias: {
        '@': path.join(root, 'packages/renderer/src'),
        '@dofemu/shared': path.join(root, 'packages/shared/index.ts')
      }
    },
    build: {
      ssr: true,
      target: 'node18',
      minify: false,
      emptyOutDir: false,
      outDir: tmpDir,
      lib: { entry, formats: ['es'] }
    }
  })
  return import(`${pathToFileURL(path.join(tmpDir, name)).href}?t=${Date.now()}`)
}

/** A seeded generator, so a failing run can be replayed exactly. */
function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = (rng, list) => list[Math.floor(rng() * list.length)]
const between = (rng, low, high) => low + Math.floor(rng() * (high - low + 1))

/* ------------------------------------------------------------------ world */

const LEVEL_DEFAULTS = {
  apCost: 3,
  range: 6,
  minRange: 0,
  castInLine: false,
  castInDiagonal: false,
  castTestLos: true,
  needFreeCell: false,
  needTakenCell: false
}

/** A spell as the client describes one. */
function spellOf(id, over = {}) {
  const { name, ...level } = over
  return {
    id,
    spell: { nameId: name ?? `Spell ${id}` },
    spellLevel: {
      ...LEVEL_DEFAULTS,
      effects: [{ effectId: 97, diceNum: 20, diceSide: 24, zoneSize: 0 }],
      ...level
    }
  }
}

function createWorld(options) {
  const {
    myCell,
    actionPoints = 6,
    movementPoints = 3,
    monsters = [],
    allies = [],
    spells = {},
    walls = new Set(),
    characteristics = {}
  } = options

  const world = {
    turn: 0,
    walls,
    me: { id: 7, cellId: myCell, life: 3000, maxLife: 3000, ap: actionPoints, mp: movementPoints },
    monsters: monsters.map((monster, index) => ({
      id: 20 + index,
      name: monster.name ?? `Monster ${index + 1}`,
      cellId: monster.cellId,
      life: monster.life ?? 200,
      maxLife: monster.maxLife ?? monster.life ?? 200,
      mp: monster.mp ?? 3,
      resists: monster.resists ?? {},
      summoned: monster.summoned,
      summoner: monster.summoner,
      alive: true
    })),
    allies: allies.map((ally, index) => ({
      id: 50 + index,
      name: ally.name ?? `Ally ${index + 1}`,
      cellId: ally.cellId,
      life: ally.life ?? 200,
      maxLife: ally.maxLife ?? 200,
      mp: 3,
      alive: true
    })),
    violations: []
  }

  const fighterOf = (entity, teamId) => ({
    id: entity.id,
    data: {
      teamId,
      alive: entity.alive !== false,
      disposition: { cellId: entity.cellId },
      stats: {
        lifePoints: entity.life,
        maxLifePoints: entity.maxLife ?? entity.life,
        actionPoints: entity.ap ?? 0,
        movementPoints: entity.mp ?? 0,
        range: entity.rangeBonus ?? 0,
        ...(entity.summoned === undefined ? {} : { summoned: entity.summoned }),
        ...(entity.summoner === undefined ? {} : { summoner: entity.summoner }),
        ...(entity.resists ?? {})
      },
      name: entity.name ?? 'Tester'
    }
  })

  // Walls block sight as well as movement, which is what the client's own
  // cell flags say and what makes a line-of-sight test mean anything.
  const cells = {}
  for (const wall of walls) cells[wall] = { los: false, l: 0 }

  world.gameWindow = {
    gui: {
      isConnected: () => true,
      playerData: {
        characterBaseInformations: { id: 7, name: 'Tester' },
        isFighting: true,
        characters: { mainCharacter: { spellData: { spells }, characteristics } }
      },
      fightManager: {
        isFightStarted: true,
        get fighters() {
          return [
            fighterOf(world.me, 0),
            ...world.allies.filter((ally) => ally.alive).map((ally) => fighterOf(ally, 0)),
            ...world.monsters.filter((monster) => monster.alive).map((monster) => fighterOf(monster, 1))
          ]
        }
      },
      on: () => {}
    },
    isoEngine: {
      mapRenderer: {
        mapId: 1,
        map: { id: 1, cells },
        isWalkable: (cellId) => !walls.has(cellId)
      },
      actorManager: {
        get userActor() {
          return { cellId: world.me.cellId }
        },
        actors: {}
      }
    },
    dofus: { connectionManager: { on: () => {}, removeListener: () => {} } }
  }

  return world
}

/* --------------------------------------------------------------- referee */

/**
 * Plays a plan the way the server would, and records everything it would
 * have refused. Anything recorded here is a bug the AI would have shown in a
 * real fight.
 */
function applyPlan(world, plan, tools) {
  const { cellDistance, areaCells, createGrid, damageWith, readDamageProfile, readResistances } = tools
  const grid = createGrid(world.gameWindow)
  const profile = readDamageProfile(world.gameWindow)

  let apLeft = world.me.ap
  let mpLeft = world.me.mp
  let casts = 0

  for (const action of plan?.actions ?? []) {
    if (action.type === 'move') {
      const cost = action.path.length - 1
      if (cost !== action.cost) {
        world.violations.push(`turn ${world.turn}: a move claimed ${action.cost} MP and walked ${cost}`)
      }
      if (cost > mpLeft) {
        world.violations.push(`turn ${world.turn}: walked ${cost} cells with ${mpLeft} MP`)
        continue
      }
      if (action.path[0] !== world.me.cellId) {
        world.violations.push(`turn ${world.turn}: a move started somewhere else`)
        continue
      }
      let illegal = null
      for (let index = 1; index < action.path.length; index++) {
        const step = action.path[index]
        if (cellDistance(action.path[index - 1], step) !== 1) illegal = `jumped to ${step}`
        else if (world.walls.has(step)) illegal = `walked through a wall on ${step}`
        else if (world.monsters.some((monster) => monster.alive && monster.cellId === step)) {
          illegal = `walked through a monster on ${step}`
        }
      }
      if (illegal) {
        world.violations.push(`turn ${world.turn}: ${illegal}`)
        continue
      }
      mpLeft -= cost
      world.me.cellId = action.cellId
      continue
    }

    const spell = tools.catalogue.find((candidate) => candidate.id === action.spellId)
    if (!spell) {
      world.violations.push(`turn ${world.turn}: cast an unknown spell ${action.spellId}`)
      continue
    }
    if (action.apCost > apLeft) {
      world.violations.push(
        `turn ${world.turn}: cast ${spell.name} for ${action.apCost} AP with ${apLeft} left`
      )
      continue
    }

    const range = spell.range + (spell.rangeBoostable ? (world.me.rangeBonus ?? 0) : 0)
    const distance = cellDistance(world.me.cellId, action.cellId)
    if (distance > range || distance < spell.minRange) {
      world.violations.push(
        `turn ${world.turn}: cast ${spell.name} at ${distance} cells, range ${spell.minRange}-${range}`
      )
      continue
    }
    if (spell.needsLineOfSight) {
      const blockers = new Set(
        [...world.monsters, ...world.allies]
          .filter((fighter) => fighter.alive && fighter.cellId !== action.cellId)
          .map((fighter) => fighter.cellId)
      )
      if (!grid.sees(world.me.cellId, action.cellId, blockers)) {
        world.violations.push(`turn ${world.turn}: cast ${spell.name} with no line of sight`)
        continue
      }
    }

    const covered = areaCells(spell.zone, world.me.cellId, action.cellId)
    const standing = world.monsters
      .filter((monster) => monster.alive && covered.includes(monster.cellId))
      .map((monster) => monster.id)
    const missed = action.hits.filter((id) => !standing.includes(id))
    if (missed.length > 0) {
      world.violations.push(
        `turn ${world.turn}: ${spell.name} claimed ${action.hits.length} hit(s) and touched ${standing.length}`
      )
    }

    apLeft -= action.apCost
    casts += 1

    if (spell.rangeBoost > 0) world.me.rangeBonus = spell.rangeBoost

    if (spell.pushDistance > 0) {
      const anchor = tools.cellCoordinates(world.me.cellId)
      for (const id of standing) {
        const monster = world.monsters.find((candidate) => candidate.id === id)
        const here = tools.cellCoordinates(monster.cellId)
        const dx = here.x - anchor.x
        const dy = here.y - anchor.y
        const stepX = Math.abs(dx) >= Math.abs(dy) ? Math.sign(dx) : 0
        const stepY = stepX === 0 ? Math.sign(dy) : 0
        for (let step = 1; step <= spell.pushDistance; step++) {
          const next = tools.cellFromCoordinates(here.x + stepX * step, here.y + stepY * step)
          if (next === null || world.walls.has(next) || next === world.me.cellId) break
          if (world.monsters.some((other) => other.alive && other.cellId === next)) break
          monster.cellId = next
        }
      }
    }

    for (const hit of standing) {
      const monster = world.monsters.find((candidate) => candidate.id === hit)
      const dealt = damageWith(spell, readResistances({ stats: monster.resists }), profile)
      monster.life -= dealt
      if (monster.life <= 0) monster.alive = false
    }
  }

  return { apLeft, mpLeft, casts }
}

/* ----------------------------------------------------------------- suites */

/**
 * The whole suite, against one seed.
 *
 * Run it against several and a rule that only holds for one arrangement of
 * monsters has nowhere left to hide.
 */
async function runSuite(combat, SEED) {
  const {
    cellDistance,
    cellCoordinates,
    cellFromCoordinates,
    cellsInRing,
    areaCells,
    areaReach,
    createGrid,
    readSpellCatalogue,
    readDamageProfile,
    readResistances,
    damageWith,
    planTurn,
    choosePlacement,
    syntheticSpell,
    weaponsFromSpellbook,
    buildSnapshot,
    resolvePlan,
    parseModelAnswer,
    aimCandidates,
    canAimAt,
    legalAimCells,
    effectiveRange,
    readBattlefield
  } = combat

  const tools = {
    cellDistance,
    cellCoordinates,
    cellFromCoordinates,
    areaCells,
    createGrid,
    damageWith,
    readDamageProfile,
    readResistances
  }

  const CELL_COUNT = 560
  const rng = random(SEED)
  console.log(`seed ${SEED}`)

  /* --- 1. range bands against a sweep of the whole map --- */
  {
    let checked = 0
    for (let round = 0; round < 400; round++) {
      const from = between(rng, 0, CELL_COUNT - 1)
      const min = between(rng, 0, 4)
      const max = min + between(rng, 0, 8)

      const expected = []
      for (let cellId = 0; cellId < CELL_COUNT; cellId++) {
        const distance = cellDistance(from, cellId)
        if (distance >= min && distance <= max) expected.push(cellId)
      }

      const got = cellsInRing(from, min, max)
      assert.strictEqual(
        new Set(got).size,
        got.length,
        `seed ${SEED}: the ring of ${from} (${min}-${max}) repeats a cell`
      )
      assert.deepStrictEqual(
        [...got].sort((a, b) => a - b),
        expected,
        `seed ${SEED}: the ring of ${from} (${min}-${max}) is not the band it claims`
      )
      checked += 1
    }
    console.log(`ok - range bands match a full sweep of the map (${checked} rounds)`)
  }

  /* --- 2. an area never reaches further than it says --- */
  {
    const shapes = ['circle', 'square', 'cross', 'diagonal-cross', 'line', 'perpendicular', 'ring']
    let checked = 0
    for (let round = 0; round < 400; round++) {
      const zone = {
        shape: pick(rng, shapes),
        size: between(rng, 1, 4),
        minSize: between(rng, 0, 1)
      }
      const from = between(rng, 0, CELL_COUNT - 1)
      const target = between(rng, 0, CELL_COUNT - 1)
      const reach = areaReach(zone)

      for (const cellId of areaCells(zone, from, target)) {
        assert.ok(
          cellDistance(cellId, target) <= reach,
          `seed ${SEED}: a ${zone.shape}/${zone.size} covers a cell ${cellDistance(cellId, target)} away, ` +
            `beyond the ${reach} it is searched within`
        )
      }
      checked += 1
    }
    console.log(`ok - every area stays inside the reach the aiming searches (${checked} shapes)`)
  }

  /* --- 3. a walk is always a legal walk --- */
  {
    for (let round = 0; round < 120; round++) {
      const walls = new Set()
      for (let index = 0; index < between(rng, 0, 60); index++) {
        walls.add(between(rng, 0, CELL_COUNT - 1))
      }
      const from = between(rng, 0, CELL_COUNT - 1)
      if (walls.has(from)) walls.delete(from)

      const blocked = new Set()
      for (let index = 0; index < between(rng, 0, 6); index++) {
        blocked.add(between(rng, 0, CELL_COUNT - 1))
      }
      blocked.delete(from)

      const world = createWorld({ myCell: from, walls })
      const grid = createGrid(world.gameWindow)
      const budget = between(rng, 1, 6)

      for (const entry of grid.reachable(from, budget, blocked).values()) {
        assert.strictEqual(entry.path[0], from, `seed ${SEED}: a path starts elsewhere`)
        assert.strictEqual(
          entry.path[entry.path.length - 1],
          entry.cellId,
          `seed ${SEED}: a path ends elsewhere`
        )
        assert.strictEqual(entry.path.length - 1, entry.cost, `seed ${SEED}: the cost is not the walk`)
        assert.ok(entry.cost <= budget, `seed ${SEED}: a walk went past its points`)

        for (let index = 1; index < entry.path.length; index++) {
          const step = entry.path[index]
          assert.strictEqual(
            cellDistance(entry.path[index - 1], step),
            1,
            `seed ${SEED}: a walk jumped a cell`
          )
          assert.ok(!walls.has(step), `seed ${SEED}: a walk crossed a wall`)
          assert.ok(!blocked.has(step), `seed ${SEED}: a walk crossed a fighter`)
        }
      }
    }
    console.log('ok - every reachable cell comes with a legal walk to it (120 maps)')
  }

  /* --- 4. the aiming finds the cell that covers the most --- */
  {
    let rounds = 0
    let multiHits = 0

    for (let round = 0; round < 400; round++) {
      const me = cellFromCoordinates(between(rng, 6, 12), between(rng, 6, 12))
      const centre = cellFromCoordinates(between(rng, 13, 18), between(rng, 6, 12))
      if (me === null || centre === null) continue
      const cluster = cellCoordinates(centre)

      const monsters = []
      const taken = new Set([me])
      for (let index = 0; index < between(rng, 2, 4); index++) {
        const cellId = cellFromCoordinates(
          cluster.x + between(rng, -2, 2),
          cluster.y + between(rng, -2, 2)
        )
        if (cellId === null || taken.has(cellId)) continue
        taken.add(cellId)
        monsters.push({ cellId, life: 500 })
      }
      if (monsters.length < 2) continue

      const shape = pick(rng, [67, 71, 84, 43, 88, 79]) // C G T + X O
      const spell = spellOf(1, {
        apCost: 3,
        range: between(rng, 5, 10),
        minRange: between(rng, 0, 2),
        effects: [
          { effectId: 97, diceNum: 20, diceSide: 24, zoneShape: shape, zoneSize: between(rng, 1, 2) }
        ]
      })

      const world = createWorld({ myCell: me, monsters, spells: { 1: spell }, actionPoints: 3 })
      const field = readBattlefield(world.gameWindow, { turn: 1 })
      const details = readSpellCatalogue(world.gameWindow)[0]

      const context = {
        grid: field.grid,
        rangeBonus: 0,
        occupied: field.occupied,
        enemies: field.enemies,
        friends: [field.me]
      }

      // The best any cell on the map could do, under the same rules.
      let best = 0
      for (let cellId = 0; cellId < CELL_COUNT; cellId++) {
        if (!canAimAt(context, details, me, cellId)) continue
        const covered = new Set(areaCells(details.zone, me, cellId))
        const caught = field.enemies.filter((enemy) => covered.has(enemy.cellId)).length
        if (caught > best) best = caught
      }
      if (best === 0) continue

      const candidates = aimCandidates(context, details, me, field.enemies, 5)
      assert.ok(candidates.length > 0, `seed ${SEED}: no aim found where one exists`)
      assert.strictEqual(
        candidates[0].enemies.length,
        best,
        `seed ${SEED}: the aiming caught ${candidates[0].enemies.length} where ${best} was possible`
      )

      // And what it claims to cover is what the area really covers.
      const covered = new Set(areaCells(details.zone, me, candidates[0].cellId))
      for (const enemy of candidates[0].enemies) {
        assert.ok(covered.has(enemy.cellId), `seed ${SEED}: a claimed hit is outside the area`)
      }

      rounds += 1
      if (best > 1) multiHits += 1
    }

    assert.ok(rounds > 150, `enough arrangements were tried (${rounds})`)
    assert.ok(multiHits > 40, `and enough of them could catch several (${multiHits})`)
    console.log(`ok - the aiming always finds the cell covering the most (${rounds} arrangements)`)
  }

  /* --- 5. legality of every cell the aiming offers --- */
  {
    for (let round = 0; round < 150; round++) {
      const me = cellFromCoordinates(between(rng, 5, 12), between(rng, 5, 12))
      if (me === null) continue
      const walls = new Set()
      for (let index = 0; index < between(rng, 0, 40); index++) {
        walls.add(between(rng, 0, CELL_COUNT - 1))
      }
      walls.delete(me)

      const spell = spellOf(1, {
        apCost: 3,
        range: between(rng, 3, 8),
        minRange: between(rng, 0, 3),
        castInLine: rng() < 0.3,
        castTestLos: rng() < 0.8,
        effects: [{ effectId: 97, diceNum: 20, diceSide: 24, zoneSize: 0 }]
      })

      const world = createWorld({ myCell: me, spells: { 1: spell }, walls })
      const details = readSpellCatalogue(world.gameWindow)[0]
      const grid = createGrid(world.gameWindow)
      const context = { grid, rangeBonus: 0, occupied: new Set([me]), enemies: [], friends: [] }

      for (const cellId of legalAimCells(context, details, me)) {
        const distance = cellDistance(me, cellId)
        assert.ok(
          distance >= details.minRange && distance <= effectiveRange(details, 0),
          `seed ${SEED}: an offered cell is outside the range band`
        )
        if (details.castInLine) {
          const a = cellCoordinates(me)
          const b = cellCoordinates(cellId)
          assert.ok(a.x === b.x || a.y === b.y, `seed ${SEED}: a line spell was offered off its lines`)
        }
        if (details.needsLineOfSight) {
          assert.ok(grid.sees(me, cellId), `seed ${SEED}: a blocked cell was offered`)
        }
      }
    }
    console.log('ok - no illegal cell is ever offered to a cast (150 maps)')
  }

  /* --- 6. the placement stands as far back as it can still shoot --- */
  {
    let rounds = 0

    for (let round = 0; round < 200; round++) {
      const anchor = cellFromCoordinates(between(rng, 16, 20), between(rng, 8, 12))
      if (anchor === null) continue
      const monsterAt = cellCoordinates(anchor)
      const monsters = []
      const taken = new Set()
      for (let index = 0; index < between(rng, 1, 3); index++) {
        const cellId = cellFromCoordinates(
          monsterAt.x + between(rng, -1, 1),
          monsterAt.y + between(rng, -1, 1)
        )
        if (cellId === null || taken.has(cellId)) continue
        taken.add(cellId)
        monsters.push({ cellId, life: 200, mp: 3 })
      }
      if (monsters.length === 0) continue

      const offered = []
      for (let index = 0; index < between(rng, 4, 9); index++) {
        const cellId = cellFromCoordinates(between(rng, 4, 16), between(rng, 5, 16))
        if (cellId === null || taken.has(cellId) || offered.includes(cellId)) continue
        offered.push(cellId)
      }
      if (offered.length < 2) continue

      const movementPoints = between(rng, 0, 4)
      const range = between(rng, 3, 9)
      const world = createWorld({ myCell: offered[0], monsters })
      const grid = createGrid(world.gameWindow)
      const weapon = syntheticSpell(1, range)

      // A reference answer, worked out without the code under test: walk the
      // first turn's movement points from each offered cell and see whether
      // anything could be shot from anywhere they reach.
      const monsterCells = new Set(monsters.map((monster) => monster.cellId))
      const reference = offered.map((cellId) => {
        const from = [cellId, ...[...grid.reachable(cellId, movementPoints, monsterCells).keys()]]
        const opens = from.some((stand) =>
          monsters.some((monster) => {
            const distance = cellDistance(stand, monster.cellId)
            return distance <= range && distance >= 0 && grid.sees(stand, monster.cellId)
          })
        )
        const distance = Math.min(
          ...monsters.map((monster) => cellDistance(cellId, monster.cellId))
        )
        const threats = monsters.filter(
          (monster) => cellDistance(cellId, monster.cellId) <= monster.mp + 1
        ).length
        return { cellId, opens, distance, threats }
      })

      const choice = choosePlacement(world.gameWindow, offered, {
        positioning: 'keep-distance',
        movementPoints,
        weapons: [weapon]
      })
      assert.ok(choice, `seed ${SEED}: no cell was chosen from ${offered.length} offered`)

      const chosen = reference.find((entry) => entry.cellId === choice.cellId)
      const openers = reference.filter((entry) => entry.opens)

      if (openers.length > 0) {
        assert.ok(
          chosen.opens,
          `seed ${SEED}: a cell that cannot open the fight was taken over ${openers.length} that can`
        )

        const safe = openers.filter((entry) => entry.threats === 0)
        const pool = safe.length > 0 ? safe : openers
        if (safe.length > 0) {
          assert.strictEqual(
            chosen.threats,
            0,
            `seed ${SEED}: a cell in the pack's reach was taken over one out of it`
          )
        }
        const furthest = Math.max(...pool.map((entry) => entry.distance))
        assert.strictEqual(
          chosen.distance,
          furthest,
          `seed ${SEED}: took a cell ${chosen.distance} away when ${furthest} was available and just as good`
        )
      }

      // Closing in reverses the order and nothing else.
      const melee = choosePlacement(world.gameWindow, offered, {
        positioning: 'close-in',
        movementPoints,
        weapons: [weapon]
      })
      const meleeChoice = reference.find((entry) => entry.cellId === melee.cellId)
      const closest = Math.min(
        ...(openers.length > 0 ? openers : reference).map((entry) => entry.distance)
      )
      assert.strictEqual(
        meleeChoice.distance,
        closest,
        `seed ${SEED}: closing in did not take the closest cell`
      )

      rounds += 1
    }

    assert.ok(rounds > 120, `enough placements were tried (${rounds})`)
    console.log(`ok - the placement is the furthest cell that can still open (${rounds} offers)`)
  }

  /* --- 7. the first turn's movement points buy distance --- */
  {
    // A bow of five against a monster eight cells away: standing still, only
    // the cell four away can shoot. With four movement points the cell eight
    // away can shoot too — after a walk — and it is the one to start on.
    const monsters = [{ cellId: cellFromCoordinates(18, 10), life: 200, mp: 3 }]
    const offered = [
      cellFromCoordinates(14, 10),
      cellFromCoordinates(12, 10),
      cellFromCoordinates(10, 10),
      cellFromCoordinates(8, 10)
    ]
    const world = createWorld({ myCell: offered[0], monsters })
    const weapon = syntheticSpell(1, 5)

    const still = choosePlacement(world.gameWindow, offered, {
      positioning: 'keep-distance',
      movementPoints: 0,
      weapons: [weapon]
    })
    const walking = choosePlacement(world.gameWindow, offered, {
      positioning: 'keep-distance',
      movementPoints: 4,
      weapons: [weapon]
    })

    assert.strictEqual(still.opensStanding, true, 'with no MP it starts where it can shoot')
    assert.strictEqual(still.distanceToClosestEnemy, 4, 'which is the only cell in range')

    assert.strictEqual(walking.opensAfterMoving, true, 'with MP it still opens the fight')
    assert.ok(
      walking.distanceToClosestEnemy > still.distanceToClosestEnemy,
      `and stands further back for it (${still.distanceToClosestEnemy} to ${walking.distanceToClosestEnemy})`
    )
    assert.ok(
      walking.openingCost <= 4,
      'within the movement points the first turn really has'
    )

    // Out of everyone's reach beats one more cell of distance.
    const closeButSafe = cellFromCoordinates(13, 10) // 5 away, out of a 4-cell reach
    const nearer = cellFromCoordinates(15, 10) // 3 away, inside it
    const safe = choosePlacement(world.gameWindow, [nearer, closeButSafe], {
      positioning: 'keep-distance',
      movementPoints: 0,
      weapons: [weapon]
    })
    assert.strictEqual(safe.cellId, closeButSafe, 'the cell the monster cannot reach wins')
    assert.strictEqual(safe.threats, 0, 'and it says so')

    console.log("ok - the first turn's movement points buy distance at placement")
  }

  /* --- 8. everything the model is offered is legal, and nothing else gets through --- */
  {
    for (let round = 0; round < 60; round++) {
      const me = cellFromCoordinates(between(rng, 8, 12), between(rng, 8, 12))
      if (me === null) continue
      const monsters = []
      for (let index = 0; index < between(rng, 1, 3); index++) {
        const cellId = cellFromCoordinates(between(rng, 13, 17), between(rng, 7, 13))
        if (cellId === null || cellId === me) continue
        if (monsters.some((monster) => monster.cellId === cellId)) continue
        monsters.push({ cellId, life: between(rng, 40, 400), mp: 3 })
      }
      if (monsters.length === 0) continue

      const spells = {
        1: spellOf(1, { apCost: 3, range: 6, effects: [{ effectId: 97, diceNum: 20, diceSide: 24, zoneSize: 0 }] }),
        2: spellOf(2, {
          apCost: 4,
          range: 7,
          minRange: 1,
          effects: [{ effectId: 97, diceNum: 25, diceSide: 30, zoneShape: 67, zoneSize: 1 }]
        })
      }

      const actionPoints = between(rng, 3, 10)
      const world = createWorld({ myCell: me, monsters, spells, actionPoints, movementPoints: 3 })
      const catalogue = readSpellCatalogue(world.gameWindow)
      const grid = createGrid(world.gameWindow)

      const snapshot = buildSnapshot(world.gameWindow, {
        turn: 1,
        elements: [],
        lastCastTurn: new Map(),
        actionPoints,
        movementPoints: 3,
        canMove: true
      })
      assert.ok(snapshot, `seed ${SEED}: no snapshot was built`)

      const everyCast = [...snapshot.casts, ...snapshot.moves.flatMap((move) => move.casts)]
      for (const cast of everyCast) {
        const spell = catalogue.find((candidate) => candidate.id === cast.spell)
        assert.ok(spell, `seed ${SEED}: an offered cast names an unknown spell`)
        assert.ok(cast.ap <= snapshot.me.ap, `seed ${SEED}: an offered cast costs more than the turn has`)
        assert.ok(cast.hits.length > 0, `seed ${SEED}: an offered attack hits nobody`)
      }
      for (const cast of snapshot.casts) {
        const spell = catalogue.find((candidate) => candidate.id === cast.spell)
        const distance = cellDistance(me, cast.cell)
        assert.ok(
          distance >= spell.minRange && distance <= spell.range,
          `seed ${SEED}: an offered cast is out of its own range`
        )
        if (spell.needsLineOfSight) {
          assert.ok(grid.sees(me, cast.cell), `seed ${SEED}: an offered cast has no line`)
        }
      }

      // Whatever a model answers — keys it made up, keys from the wrong
      // position, more than its points can pay for — nothing illegal comes out.
      const keys = [...everyCast.map((cast) => cast.k), ...snapshot.moves.map((move) => move.k)]
      for (let attempt = 0; attempt < 8; attempt++) {
        const plan = []
        for (let index = 0; index < between(rng, 1, 6); index++) {
          plan.push(rng() < 0.75 && keys.length > 0 ? pick(rng, keys) : `x${between(rng, 1, 99)}`)
        }

        const resolved = resolvePlan(snapshot, { plan })
        let spent = 0
        let moves = 0
        let after = null

        for (const action of resolved.actions) {
          if (action.type === 'move') {
            moves += 1
            after = snapshot.moves.find((move) => move.cell === action.cellId)
            assert.ok(after, `seed ${SEED}: a move that was never offered got through`)
            continue
          }
          spent += action.apCost
          const allowed = after ? after.casts : snapshot.casts
          assert.ok(
            allowed.some((cast) => cast.spell === action.spellId && cast.cell === action.cellId),
            `seed ${SEED}: a cast that was never offered from that cell got through`
          )
        }

        assert.ok(moves <= 1, `seed ${SEED}: more than one move got through`)
        assert.ok(spent <= snapshot.me.ap, `seed ${SEED}: the plan spent ${spent} of ${snapshot.me.ap} AP`)
      }
    }
    console.log('ok - the model is offered only legal casts, and can answer nothing else (60 fights)')
  }

  /* --- 9. the mastery, and the points it has to leave behind --- */
  {
    const mastery = spellOf(1, {
      name: 'Maîtrise',
      apCost: 2,
      range: 0,
      minCastInterval: 3,
      effects: [{ effectId: 117, diceNum: 2, diceSide: 2, zoneSize: 0, duration: 3 }]
    })
    const arrow = spellOf(2, {
      name: 'Flèche',
      apCost: 4,
      range: 6,
      rangeCanBeBoosted: true,
      effects: [{ effectId: 97, diceNum: 25, diceSide: 30, zoneSize: 0 }]
    })

    const build = (actionPoints, lastCastTurn = new Map(), turn = 1) => {
      const world = createWorld({
        myCell: cellFromCoordinates(10, 10),
        actionPoints,
        movementPoints: 0,
        monsters: [{ cellId: cellFromCoordinates(15, 10), life: 4000 }],
        spells: { 1: mastery, 2: arrow }
      })
      return {
        world,
        plan: planTurn(world.gameWindow, {
          turn,
          actionPoints,
          movementPoints: 0,
          elements: [],
          lastCastTurn,
          canMove: false,
          keepDistance: true
        })
      }
    }

    const catalogue = readSpellCatalogue(build(6).world.gameWindow)
    assert.strictEqual(catalogue[0].isMastery, true, 'a self-cast range buff is read as a mastery')
    assert.strictEqual(catalogue[0].buffTurns, 3, 'and its duration is read')

    const rich = build(8)
    assert.strictEqual(rich.plan.casts[0].spellId, 1, 'with points to spare the mastery opens the turn')
    assert.ok(
      rich.plan.casts.slice(1).some((cast) => cast.spellId === 2),
      'and the attack still follows it'
    )

    const tight = build(4)
    assert.ok(
      tight.plan.casts.every((cast) => cast.spellId !== 1),
      'with only enough points for one attack the mastery is skipped'
    )
    assert.strictEqual(tight.plan.casts[0].spellId, 2, 'and the attack is thrown instead')

    // Cast on turn one, it waits its cooldown out rather than being recast.
    const cooling = build(8, new Map([[1, 1]]), 2)
    assert.ok(
      cooling.plan.casts.every((cast) => cast.spellId !== 1),
      'a mastery on cooldown is not recast'
    )
    assert.ok(
      cooling.plan.leftOut.some((line) => line.includes('cooldown')),
      `and the turn says why (${cooling.plan.leftOut.join(' | ')})`
    )

    // Off cooldown again, it goes straight back up.
    const again = build(8, new Map([[1, 1]]), 4)
    assert.strictEqual(again.plan.casts[0].spellId, 1, 'once the cooldown is out it is recast')

    // And the forcing can be turned off. A buff with no duration to speak of,
    // against an area cast that catches three: on, the mastery still opens the
    // turn; off, it is weighed like any other cast and the area wins.
    const brief = spellOf(1, {
      name: 'Maîtrise brève',
      apCost: 2,
      range: 0,
      minCastInterval: 3,
      effects: [{ effectId: 117, diceNum: 1, diceSide: 1, zoneSize: 0 }]
    })
    const barrage = spellOf(2, {
      name: 'Barrage',
      apCost: 4,
      range: 6,
      rangeCanBeBoosted: true,
      effects: [{ effectId: 97, diceNum: 30, diceSide: 34, zoneShape: 67, zoneSize: 1 }]
    })

    const crowd = () =>
      createWorld({
        myCell: cellFromCoordinates(10, 10),
        actionPoints: 8,
        movementPoints: 0,
        monsters: [
          { cellId: cellFromCoordinates(15, 10), life: 4000 },
          { cellId: cellFromCoordinates(15, 11), life: 4000 },
          { cellId: cellFromCoordinates(16, 10), life: 4000 }
        ],
        spells: { 1: brief, 2: barrage },
        characteristics: { strength: { base: 200 }, intelligence: { base: 0 }, chance: { base: 0 }, agility: { base: 0 } }
      })

    const context = (over) => ({
      turn: 1,
      actionPoints: 8,
      movementPoints: 0,
      elements: [],
      lastCastTurn: new Map(),
      canMove: false,
      keepDistance: true,
      ...over
    })

    const forced = planTurn(crowd().gameWindow, context({}))
    assert.strictEqual(forced.casts[0].spellId, 1, 'kept up, the mastery opens the turn')

    const weighed = planTurn(crowd().gameWindow, context({ keepMasteryUp: false }))
    assert.strictEqual(
      weighed.casts[0].spellId,
      2,
      'with the setting off the area cast that catches three wins instead'
    )

    console.log('ok - the mastery goes up whenever the cooldown and the points allow')
  }

  /* --- 10. whole generated fights, refereed --- */
  {
    const shapes = [0, 67, 71, 84, 43]
    let fights = 0
    let castsSeen = 0
    let killsSeen = 0

    for (let round = 0; round < 200; round++) {
      const walls = new Set()
      for (let index = 0; index < between(rng, 0, 30); index++) {
        const wall = cellFromCoordinates(between(rng, 6, 20), between(rng, 4, 12))
        if (wall !== null) walls.add(wall)
      }

      const me = cellFromCoordinates(between(rng, 8, 12), between(rng, 4, 8))
      if (me === null) continue
      walls.delete(me)

      const monsters = []
      for (let index = 0; index < between(rng, 1, 4); index++) {
        const cellId = cellFromCoordinates(between(rng, 13, 19), between(rng, 5, 12))
        if (cellId === null || cellId === me) continue
        if (monsters.some((monster) => monster.cellId === cellId)) continue
        walls.delete(cellId)
        monsters.push({ cellId, life: between(rng, 60, 500), mp: between(rng, 1, 4) })
      }
      if (monsters.length === 0) continue

      const spells = {}
      for (let index = 1; index <= between(rng, 1, 4); index++) {
        const shape = pick(rng, shapes)
        spells[index] = spellOf(index, {
          apCost: between(rng, 2, 5),
          range: between(rng, 2, 9),
          minRange: between(rng, 0, 2),
          castInLine: rng() < 0.2,
          castTestLos: rng() < 0.85,
          maxCastPerTurn: rng() < 0.3 ? between(rng, 1, 3) : null,
          rangeCanBeBoosted: true,
          effects: [
            {
              effectId: pick(rng, [96, 97, 98, 99, 100]),
              diceNum: between(rng, 10, 40),
              diceSide: between(rng, 10, 45),
              zoneShape: shape || undefined,
              zoneSize: shape ? between(rng, 1, 2) : 0
            },
            ...(rng() < 0.2 ? [{ effectId: 5, diceNum: 1, zoneSize: 0 }] : [])
          ]
        })
      }

      const actionPoints = between(rng, 3, 11)
      const movementPoints = between(rng, 0, 5)
      const keepDistance = rng() < 0.7

      const world = createWorld({
        myCell: me,
        actionPoints,
        movementPoints,
        monsters,
        spells,
        walls,
        characteristics: { strength: { base: between(rng, 0, 300) }, intelligence: { base: 0 } }
      })

      const catalogue = readSpellCatalogue(world.gameWindow)
      const lastCastTurn = new Map()
      const lifeAtStart = world.monsters.reduce((total, monster) => total + monster.life, 0)

      for (let turn = 1; turn <= 6; turn++) {
        world.turn = turn
        if (world.monsters.every((monster) => !monster.alive)) break
        world.me.ap = actionPoints
        world.me.mp = movementPoints

        const started = Date.now()
        const plan = planTurn(world.gameWindow, {
          turn,
          actionPoints,
          movementPoints,
          elements: [],
          lastCastTurn,
          canMove: movementPoints > 0,
          keepDistance
        })
        const elapsed = Date.now() - started

        assert.ok(plan, `seed ${SEED}: no plan at all on turn ${turn}`)
        assert.ok(
          elapsed < 2000,
          `seed ${SEED}: planning turn ${turn} took ${elapsed}ms`
        )
        assert.ok(
          plan.actions.length > 0 || typeof plan.diagnostic === 'string',
          `seed ${SEED}: a turn did nothing and did not say why`
        )
        // Moving between two casts is allowed — the points are worth more
        // spent where a kill has just opened ground — but a turn that never
        // stops planning is a turn the client never gets to play.
        assert.ok(
          plan.actions.length <= 15,
          `seed ${SEED}: a turn planned ${plan.actions.length} actions`
        )
        const walked = plan.actions
          .filter((action) => action.type === 'move')
          .reduce((total, action) => total + action.cost, 0)
        assert.ok(
          walked <= movementPoints,
          `seed ${SEED}: a turn walked ${walked} cells with ${movementPoints} MP`
        )

        for (const cast of plan.casts) lastCastTurn.set(cast.spellId, turn)
        const outcome = applyPlan(world, plan, { ...tools, catalogue })
        castsSeen += outcome.casts

        assert.deepStrictEqual(
          world.violations,
          [],
          `seed ${SEED}: the referee refused something on turn ${turn}`
        )
      }

      const lifeAtEnd = world.monsters.reduce(
        (total, monster) => total + Math.max(0, monster.life),
        0
      )
      killsSeen += world.monsters.filter((monster) => !monster.alive).length
      assert.ok(lifeAtEnd <= lifeAtStart, `seed ${SEED}: a fight healed the monsters`)

      fights += 1
    }

    assert.ok(fights > 150, `enough fights were played (${fights})`)
    assert.ok(castsSeen > fights, `and they were actually fought (${castsSeen} casts)`)
    assert.ok(killsSeen > 20, `with monsters actually dying (${killsSeen} kills)`)
    console.log(
      `ok - ${fights} generated fights, ${castsSeen} casts, ${killsSeen} kills, nothing the server would refuse`
    )
  }

  /* --- 11. planning stays fast enough to play a turn with --- */
  {
    const monsters = []
    for (let index = 0; index < 6; index++) {
      monsters.push({ cellId: cellFromCoordinates(15 + (index % 3), 8 + Math.floor(index / 3)), life: 600, mp: 3 })
    }
    const spells = {}
    for (let index = 1; index <= 8; index++) {
      spells[index] = spellOf(index, {
        apCost: 2 + (index % 3),
        range: 4 + (index % 5),
        minRange: index % 2,
        effects: [
          {
            effectId: 96 + (index % 5),
            diceNum: 20,
            diceSide: 30,
            zoneShape: index % 2 ? 67 : undefined,
            zoneSize: index % 2 ? 2 : 0
          }
        ]
      })
    }

    const world = createWorld({
      myCell: cellFromCoordinates(10, 10),
      actionPoints: 12,
      movementPoints: 6,
      monsters,
      spells,
      characteristics: { strength: { base: 300 } }
    })

    const started = Date.now()
    const rounds = 12
    for (let index = 0; index < rounds; index++) {
      planTurn(world.gameWindow, {
        turn: 1,
        actionPoints: 12,
        movementPoints: 6,
        elements: [],
        lastCastTurn: new Map(),
        canMove: true,
        keepDistance: true
      })
    }
    const each = (Date.now() - started) / rounds

    assert.ok(each < 1500, `a busy turn is planned in ${Math.round(each)}ms, which is too slow`)
    console.log(`ok - a six-monster, eight-spell turn is planned in ${Math.round(each)}ms`)
  }

  /* --- 12. the whole pipeline: snapshot, model answer, actions --- */
  {
    const world = createWorld({
      myCell: cellFromCoordinates(10, 10),
      actionPoints: 8,
      movementPoints: 3,
      monsters: [
        { cellId: cellFromCoordinates(15, 10), life: 60, maxLife: 300, mp: 3, name: 'Piou Bleu' },
        { cellId: cellFromCoordinates(15, 11), life: 300, mp: 3, name: 'Piou Rouge' }
      ],
      spells: {
        1: spellOf(1, {
          apCost: 4,
          range: 7,
          minRange: 1,
          effects: [{ effectId: 97, diceNum: 30, diceSide: 34, zoneShape: 67, zoneSize: 1 }]
        })
      },
      characteristics: { strength: { base: 200 }, intelligence: { base: 0 }, chance: { base: 0 }, agility: { base: 0 } }
    })

    const snapshot = buildSnapshot(world.gameWindow, {
      turn: 1,
      elements: [],
      lastCastTurn: new Map(),
      actionPoints: 8,
      movementPoints: 3,
      canMove: true
    })

    assert.ok(snapshot.casts.length > 0, 'casts are offered')
    assert.ok(
      snapshot.casts.some((cast) => cast.hits.length === 2),
      'including the one that covers both birds'
    )
    assert.ok(snapshot.spells[0].damage[1] > 0, 'the damage on each monster is worked out')
    assert.strictEqual(snapshot.enemies[0].hpPercent, 20, 'and how hurt each one is')

    const answer = parseModelAnswer(
      `Here is my plan: {"plan":["${snapshot.casts[0].k}"],"why":"cover both"}`
    )
    const resolved = resolvePlan(snapshot, answer)
    assert.strictEqual(resolved.actions.length, 1, 'the plan resolves to one cast')
    assert.strictEqual(resolved.actions[0].type, 'cast')
    assert.strictEqual(resolved.reason, 'cover both', 'and carries the reason')
    assert.strictEqual(resolved.castsNothing, false)

    console.log('ok - a model answer becomes a legal cast, area and all')
  }

  /* --- 13. summons are left for last --- */
  {
    const arrow = spellOf(1, {
      name: 'Flèche',
      apCost: 3,
      range: 8,
      effects: [{ effectId: 97, diceNum: 25, diceSide: 30, zoneSize: 0 }]
    })

    // The summoner and the thing it called in, both well within range.
    const build = (over = {}) =>
      createWorld({
        myCell: cellFromCoordinates(10, 10),
        actionPoints: 3,
        movementPoints: 0,
        monsters: [
          { cellId: cellFromCoordinates(15, 10), life: 400, name: 'Tofu' },
          { cellId: cellFromCoordinates(13, 11), life: 60, name: 'Invocation', ...over }
        ],
        spells: { 1: arrow },
        characteristics: { strength: { base: 200 }, intelligence: { base: 0 }, chance: { base: 0 }, agility: { base: 0 } }
      })

    const context = (over) => ({
      turn: 1,
      actionPoints: 3,
      movementPoints: 0,
      elements: [],
      lastCastTurn: new Map(),
      canMove: false,
      keepDistance: true,
      ...over
    })

    // The flag, however this build carries it.
    const field = readBattlefield(build({ summoned: true }).gameWindow, { turn: 1 })
    assert.strictEqual(
      field.enemies.find((enemy) => enemy.name === 'Invocation').summoned,
      true,
      'the summoned flag is read'
    )
    assert.strictEqual(
      field.enemies.find((enemy) => enemy.name === 'Tofu').summoned,
      false,
      'and a monster the fight started with is not one'
    )

    const bySummoner = readBattlefield(build({ summoner: 20 }).gameWindow, { turn: 1 })
    assert.strictEqual(
      bySummoner.enemies.find((enemy) => enemy.name === 'Invocation').summoned,
      true,
      'a build that only names the summoner says as much'
    )

    // The summon is nearly dead and one arrow would finish it — the kill
    // bonus makes it by far the highest-scoring cast. It is still left alone.
    const spared = planTurn(build({ summoned: true }).gameWindow, context({}))
    assert.strictEqual(spared.casts.length, 1, 'the turn still shoots')
    assert.strictEqual(
      spared.casts[0].cellId,
      cellFromCoordinates(15, 10),
      'at the summoner, not the summon it could have killed'
    )

    // With the setting off, the kill wins as any other cast would.
    const greedy = planTurn(build({ summoned: true }).gameWindow, context({ summonsLast: false }))
    assert.strictEqual(
      greedy.casts[0].cellId,
      cellFromCoordinates(13, 11),
      'with the rule off the summon is killed like anything else'
    )

    // Nothing else in reach: the summon is shot rather than the turn wasted.
    const alone = createWorld({
      myCell: cellFromCoordinates(10, 10),
      actionPoints: 3,
      movementPoints: 0,
      monsters: [
        { cellId: cellFromCoordinates(13, 10), life: 400, name: 'Invocation', summoned: true }
      ],
      spells: { 1: arrow },
      characteristics: { strength: { base: 200 }, intelligence: { base: 0 }, chance: { base: 0 }, agility: { base: 0 } }
    })
    assert.strictEqual(
      planTurn(alone.gameWindow, context({})).casts.length,
      1,
      'with only a summon in reach it is shot: casting nothing is worse'
    )

    // An area that covers the summoner as well is not held back by the rule.
    const barrage = spellOf(2, {
      name: 'Barrage',
      apCost: 4,
      range: 8,
      effects: [{ effectId: 97, diceNum: 25, diceSide: 30, zoneShape: 67, zoneSize: 2 }]
    })
    const pair = createWorld({
      myCell: cellFromCoordinates(10, 10),
      actionPoints: 4,
      movementPoints: 0,
      monsters: [
        { cellId: cellFromCoordinates(15, 10), life: 400, name: 'Tofu' },
        { cellId: cellFromCoordinates(15, 11), life: 400, name: 'Invocation', summoned: true }
      ],
      spells: { 2: barrage },
      characteristics: { strength: { base: 200 }, intelligence: { base: 0 }, chance: { base: 0 }, agility: { base: 0 } }
    })
    const together = planTurn(pair.gameWindow, context({ actionPoints: 4 }))
    assert.strictEqual(together.casts.length, 1, 'the area is cast')
    assert.strictEqual(
      together.casts[0].hits.length,
      2,
      'and catching the summon alongside the summoner is not held against it'
    )

    console.log('ok - summons are left for last, and shot when nothing else is in reach')
  }

  /* --- 14. an invulnerable monster is not a target --- */
  {
    // What the state really is: a flat reduction bigger than any hit.
    const INVULNERABLE = {
      earthElementReduction: 5000,
      fireElementReduction: 5000,
      waterElementReduction: 5000,
      airElementReduction: 5000,
      neutralElementReduction: 5000
    }

    const arrow = spellOf(1, {
      name: 'Flèche',
      apCost: 3,
      range: 8,
      effects: [{ effectId: 97, diceNum: 25, diceSide: 30, zoneSize: 0 }]
    })

    const world = createWorld({
      myCell: cellFromCoordinates(10, 10),
      actionPoints: 3,
      movementPoints: 0,
      monsters: [
        { cellId: cellFromCoordinates(13, 11), life: 80, name: 'Tronknyde', resists: INVULNERABLE },
        { cellId: cellFromCoordinates(15, 10), life: 400, name: 'Tofu' }
      ],
      spells: { 1: arrow },
      characteristics: { strength: { base: 200 }, intelligence: { base: 0 }, chance: { base: 0 }, agility: { base: 0 } }
    })

    const catalogue = readSpellCatalogue(world.gameWindow)
    const profile = readDamageProfile(world.gameWindow)

    // The number itself: a reduction that swallows the hit reads as zero, not
    // as the spell's printed dice.
    assert.strictEqual(
      Math.round(damageWith(catalogue[0], readResistances({ stats: INVULNERABLE }), profile)),
      0,
      'a hit swallowed by the reduction is worth nothing'
    )
    assert.ok(
      damageWith(catalogue[0], readResistances({ stats: {} }), profile) > 0,
      'while the same spell hurts a monster that is not under it'
    )

    const context = (over) => ({
      turn: 1,
      actionPoints: 3,
      movementPoints: 0,
      elements: [],
      lastCastTurn: new Map(),
      canMove: false,
      keepDistance: true,
      ...over
    })

    const plan = planTurn(world.gameWindow, context({}))
    assert.strictEqual(plan.casts.length, 1, 'the turn shoots')
    assert.strictEqual(
      plan.casts[0].cellId,
      cellFromCoordinates(15, 10),
      'at the monster that can be hurt, not the nearly dead invulnerable one'
    )
    assert.ok(
      plan.notes.some((note) => note.includes('Tronknyde') && note.includes('invulnerable')),
      `the state is detected and named (${plan.notes.join(' | ')})`
    )

    // Everything invulnerable: the points are worth nothing kept, so it casts
    // anyway and says why.
    const walled = createWorld({
      myCell: cellFromCoordinates(10, 10),
      actionPoints: 3,
      movementPoints: 0,
      monsters: [
        { cellId: cellFromCoordinates(13, 10), life: 300, name: 'Tronknyde', resists: INVULNERABLE }
      ],
      spells: { 1: arrow },
      characteristics: { strength: { base: 200 }, intelligence: { base: 0 }, chance: { base: 0 }, agility: { base: 0 } }
    })
    const anyway = planTurn(walled.gameWindow, context({}))
    assert.strictEqual(anyway.casts.length, 1, 'it still casts when there is nothing better')
    assert.ok(
      anyway.notes.some((note) => note.includes('invulnerable')),
      'and says the whole pack is under the state'
    )
    assert.ok(
      anyway.casts[0].reason.includes('takes nothing'),
      `the cast itself is honest about it (${anyway.casts[0].reason})`
    )

    // The model is told, and is offered nothing on the invulnerable one.
    const snapshot = buildSnapshot(world.gameWindow, {
      turn: 1,
      elements: [],
      lastCastTurn: new Map(),
      actionPoints: 3,
      movementPoints: 0,
      canMove: false
    })
    const tronknyde = snapshot.enemies.find((enemy) => enemy.name === 'Tronknyde')
    assert.strictEqual(tronknyde.immune, true, 'the snapshot flags it')
    assert.strictEqual(
      snapshot.enemies.find((enemy) => enemy.name === 'Tofu').immune,
      false,
      'and only it'
    )
    assert.ok(
      snapshot.casts.every((cast) => !cast.hits.includes(tronknyde.n)),
      'no cast on it is offered while something else can be hit'
    )
    assert.ok(
      snapshot.notes.some((note) => note.includes('invulnerable')),
      'and the model is told in words'
    )

    console.log('ok - an invulnerable monster is detected and left for the others')
  }

  /* --- 15. shoving out of contact, and shoving an obstacle aside --- */
  {
    // A barrage arrow: it hits, and it pushes a cell.
    const barrage = spellOf(2, {
      name: 'Flèche de Barrage',
      apCost: 4,
      range: 6,
      minRange: 1,
      effects: [
        { effectId: 97, diceNum: 25, diceSide: 30, zoneSize: 0 },
        { effectId: 5, diceNum: 1, zoneSize: 0 }
      ]
    })
    // And a plain one that hits harder and pushes nothing.
    const arrow = spellOf(1, {
      name: 'Flèche',
      apCost: 4,
      range: 8,
      effects: [{ effectId: 97, diceNum: 30, diceSide: 35, zoneSize: 0 }]
    })

    const sheet = {
      strength: { base: 200 },
      intelligence: { base: 0 },
      chance: { base: 0 },
      agility: { base: 0 }
    }
    const context = (over) => ({
      turn: 1,
      actionPoints: 4,
      movementPoints: 0,
      elements: [],
      lastCastTurn: new Map(),
      canMove: false,
      keepDistance: true,
      ...over
    })

    const held = cellFromCoordinates(11, 10)
    const behind = cellFromCoordinates(12, 10)

    // A monster in contact. Fleeing on foot is tackled; shoving it is not, so
    // the arrow that pushes wins over the one that hits harder.
    const melee = createWorld({
      myCell: cellFromCoordinates(10, 10),
      actionPoints: 4,
      movementPoints: 0,
      monsters: [{ cellId: held, life: 500, name: 'Bouftou' }],
      spells: { 1: arrow, 2: barrage },
      characteristics: sheet
    })

    const shove = planTurn(melee.gameWindow, context({}))
    assert.strictEqual(shove.casts.length, 1, 'the turn casts')
    assert.strictEqual(
      shove.casts[0].spellId,
      2,
      'the arrow that pushes is preferred to the one that hits harder'
    )
    assert.strictEqual(shove.casts[0].cellId, held, 'and it is aimed at the monster holding us')

    // A melee build wants it exactly the other way round.
    const closing = planTurn(melee.gameWindow, context({ keepDistance: false }))
    assert.strictEqual(
      closing.casts[0].spellId,
      1,
      'closing in, the harder hit wins: pushing the target away is the last thing it wants'
    )

    // Out of contact, the push buys nothing and the harder hit wins again —
    // the plan must not walk into melee just to shove its way back out.
    const apart = createWorld({
      myCell: cellFromCoordinates(10, 10),
      actionPoints: 4,
      movementPoints: 3,
      monsters: [{ cellId: cellFromCoordinates(14, 10), life: 500, name: 'Bouftou' }],
      spells: { 1: arrow, 2: barrage },
      characteristics: sheet
    })
    const atRange = planTurn(apart.gameWindow, context({ movementPoints: 3, canMove: true }))
    assert.strictEqual(
      atRange.casts[0].spellId,
      1,
      'at range the push is worth nothing and the harder hit is taken'
    )
    assert.ok(
      atRange.actions.every(
        (action) =>
          action.type !== 'move' || cellDistance(action.cellId, cellFromCoordinates(14, 10)) > 1
      ),
      'and no move walks into contact for the sake of a shove'
    )

    // A summon is an obstacle that can be moved. Held by one, with a monster
    // it could shoot instead, the turn shoves the summon off it — the damage
    // done to the summon counts for almost nothing, the freedom for a lot.
    const blocked = createWorld({
      myCell: cellFromCoordinates(10, 10),
      actionPoints: 4,
      movementPoints: 0,
      monsters: [
        { cellId: cellFromCoordinates(10, 9), life: 500, name: 'Invocation', summoned: true },
        { cellId: cellFromCoordinates(15, 10), life: 500, name: 'Tofu' }
      ],
      spells: { 1: arrow, 2: barrage },
      characteristics: sheet
    })

    const cleared = planTurn(blocked.gameWindow, context({}))
    assert.strictEqual(
      cleared.casts[0].spellId,
      2,
      'the summon holding the character is shoved rather than left there'
    )
    assert.strictEqual(
      cleared.casts[0].cellId,
      cellFromCoordinates(10, 9),
      'and the shove is aimed at the summon itself'
    )

    // Standing free, the same summon is not worth a cast: the rule holds.
    const free = createWorld({
      myCell: cellFromCoordinates(10, 10),
      actionPoints: 4,
      movementPoints: 0,
      monsters: [
        { cellId: cellFromCoordinates(12, 11), life: 500, name: 'Invocation', summoned: true },
        { cellId: cellFromCoordinates(15, 10), life: 500, name: 'Tofu' }
      ],
      spells: { 1: arrow, 2: barrage },
      characteristics: sheet
    })
    const ignored = planTurn(free.gameWindow, context({}))
    assert.ok(
      ignored.casts[0].hits.every((id) => id !== blocked.monsters[0].id),
      'a summon that is holding nothing is still left alone'
    )
    assert.strictEqual(
      ignored.casts[0].cellId,
      cellFromCoordinates(15, 10),
      'and the monster behind it is the one shot'
    )

    console.log('ok - a hold is shoved off rather than walked out of, summons included')
  }

  console.log(`— seed ${SEED} clear —`)
}

async function main() {
  const combat = await bundleModule(
    path.join(root, 'packages/renderer/src/scripts/combat/index.ts'),
    'index.js'
  )

  // One seed when asked for a replay, three otherwise: the geometry and the
  // aiming are checked against exhaustive answers, so more arrangements is
  // simply more of the map covered.
  const seeds = process.env.COMBAT_SEED ? [Number(process.env.COMBAT_SEED)] : [SEED, 991, 424242]
  for (const seed of seeds) await runSuite(combat, seed)

  console.log('\nAll combat core tests passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
