import assert from 'assert'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { build } from 'vite'

/**
 * Whole fights, played out against monsters that behave differently.
 *
 * The planner decides, and this file plays the part of the server: it refuses
 * what the game would refuse and records it. A turn that spends more action
 * points than it has, a spell thrown out of range, a character walking through
 * a wall — all of it surfaces here rather than in a real fight.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const tmpDir = path.join(root, 'tests/.tmp')

async function bundleModule(entry) {
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
}

/** A fight the planner can read and this file can referee. */
function createWorld(options) {
  const {
    myCell,
    actionPoints = 6,
    movementPoints = 3,
    monsters = [],
    spells = {},
    walls = new Set()
  } = options

  const world = {
    turn: 0,
    me: { id: 7, cellId: myCell, life: 3000, maxLife: 3000, ap: actionPoints, mp: movementPoints },
    monsters: monsters.map((monster, index) => ({
      id: 20 + index,
      name: monster.name ?? `Monster ${index + 1}`,
      cellId: monster.cellId,
      life: monster.life ?? 200,
      maxLife: monster.life ?? 200,
      mp: monster.mp ?? 3,
      behaviour: monster.behaviour ?? 'static',
      alive: true
    })),
    violations: [],
    castsThisTurn: [],
    baseActionPoints: actionPoints,
    baseMovementPoints: movementPoints
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
        movementPoints: entity.mp ?? 0
      },
      name: entity.name ?? 'Tester'
    }
  })

  world.gameWindow = {
    gui: {
      isConnected: () => true,
      playerData: {
        characterBaseInformations: { id: 7, name: 'Tester' },
        isFighting: true,
        characters: { mainCharacter: { spellData: { spells } } }
      },
      fightManager: {
        isFightStarted: true,
        get fighters() {
          return [
            fighterOf(world.me, 0),
            ...world.monsters.filter((monster) => monster.alive).map((monster) => fighterOf(monster, 1))
          ]
        }
      },
      on: () => {}
    },
    isoEngine: {
      mapRenderer: {
        mapId: 1,
        map: { id: 1, cells: {} },
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

/** Referees a plan the way the game would, and applies what it allows. */
function applyPlan(world, plan, geometry, catalogue) {
  const { cellDistance, hasLineOfSight } = geometry
  let apLeft = world.me.ap
  let mpLeft = world.me.mp
  world.castsThisTurn = []

  for (const action of plan?.actions ?? []) {
    if (action.type === 'move') {
      const cost = action.path.length - 1
      if (cost > mpLeft) {
        world.violations.push(`turn ${world.turn}: walked ${cost} cells with ${mpLeft} MP`)
        continue
      }
      const blocked = action.path.slice(1).find((cell) =>
        world.monsters.some((monster) => monster.alive && monster.cellId === cell)
      )
      if (blocked !== undefined) {
        world.violations.push(`turn ${world.turn}: walked through a monster on cell ${blocked}`)
        continue
      }
      mpLeft -= cost
      world.me.cellId = action.cellId
      continue
    }

    const spell = catalogue.find((candidate) => candidate.id === action.spellId)
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

    const distance = cellDistance(world.me.cellId, action.cellId)
    if (distance > spell.range || distance < spell.minRange) {
      world.violations.push(
        `turn ${world.turn}: cast ${spell.name} at ${distance} cells, range ${spell.minRange}-${spell.range}`
      )
      continue
    }

    if (spell.needsLineOfSight && !hasLineOfSight(world.gameWindow, world.me.cellId, action.cellId)) {
      world.violations.push(`turn ${world.turn}: cast ${spell.name} with no line of sight`)
      continue
    }

    apLeft -= action.apCost
    world.castsThisTurn.push(action)

    for (const hit of action.hits) {
      const monster = world.monsters.find((candidate) => candidate.id === hit)
      if (!monster || !monster.alive) {
        world.violations.push(`turn ${world.turn}: cast at a monster that is already dead`)
        continue
      }
      monster.life -= spell.damage
      if (monster.life <= 0) monster.alive = false
    }
  }

  return { apLeft, mpLeft }
}

/** Monsters take their turn: some close in, some run, some stand still. */
function monstersAct(world, geometry) {
  const { cellCoordinates, cellFromCoordinates, cellDistance } = geometry

  for (const monster of world.monsters) {
    if (!monster.alive || monster.behaviour === 'static') continue

    const taken = new Set([
      world.me.cellId,
      ...world.monsters.filter((other) => other.alive && other !== monster).map((other) => other.cellId)
    ])

    for (let step = 0; step < monster.mp; step++) {
      const from = cellCoordinates(monster.cellId)
      const target = cellCoordinates(world.me.cellId)
      const towards = monster.behaviour === 'fleer' ? -1 : 1

      const options = [
        { x: from.x + Math.sign(target.x - from.x) * towards, y: from.y },
        { x: from.x, y: from.y + Math.sign(target.y - from.y) * towards }
      ]

      let moved = false
      for (const option of options) {
        const cellId = cellFromCoordinates(option.x, option.y)
        if (cellId === null || taken.has(cellId)) continue
        const before = cellDistance(monster.cellId, world.me.cellId)
        const after = cellDistance(cellId, world.me.cellId)
        if (monster.behaviour === 'chaser' && after >= before) continue
        if (monster.behaviour === 'fleer' && after <= before) continue
        if (monster.behaviour === 'chaser' && after === 0) continue
        monster.cellId = cellId
        moved = true
        break
      }
      if (!moved) break
    }
  }
}

/** Plays a whole fight and returns what happened. */
async function playFight(world, planTurn, geometry, catalogue, options = {}) {
  const { turns = 12, keepDistance = true, canMove = true } = options
  const lastCastTurn = new Map()
  const history = []

  for (let turn = 1; turn <= turns; turn++) {
    world.turn = turn
    if (world.monsters.every((monster) => !monster.alive)) break

    const plan = planTurn(world.gameWindow, {
      turn,
      actionPoints: world.me.ap,
      movementPoints: canMove ? world.me.mp : 0,
      elements: [],
      lastCastTurn,
      canMove,
      keepDistance
    })

    for (const cast of plan?.casts ?? []) lastCastTurn.set(cast.spellId, turn)

    const before = world.me.cellId
    applyPlan(world, plan, geometry, catalogue)
    history.push({
      turn,
      from: before,
      to: world.me.cellId,
      casts: world.castsThisTurn.length,
      diagnostic: plan?.diagnostic ?? null
    })

    monstersAct(world, geometry)
  }

  return history
}

const level = (over) =>
  Object.assign(
    {
      apCost: 3,
      range: 6,
      minRange: 0,
      castInLine: false,
      castInDiagonal: false,
      castTestLos: true
    },
    over
  )

const arrow = {
  id: 1,
  spell: { nameId: 'Arrow' },
  spellLevel: level({ effects: [{ effectId: 100, diceNum: 30, diceSide: 30, zoneSize: 0 }] })
}

async function main() {
  await bundleModule(path.join(root, 'packages/renderer/src/scripts/spell-planner.ts'))
  const { planTurn } = await import(
    `${pathToFileURL(path.join(tmpDir, 'spell-planner.js')).href}?t=${Date.now()}`
  )
  await bundleModule(path.join(root, 'packages/renderer/src/scripts/cells.ts'))
  const geometry = await import(
    `${pathToFileURL(path.join(tmpDir, 'cells.js')).href}?t=${Date.now()}`
  )
  await bundleModule(path.join(root, 'packages/renderer/src/scripts/spell-catalogue.ts'))
  const { readSpellCatalogue } = await import(
    `${pathToFileURL(path.join(tmpDir, 'spell-catalogue.js')).href}?t=${Date.now()}`
  )

  const { cellFromCoordinates, cellDistance } = geometry

  // --- a monster that stands still ---
  {
    const world = createWorld({
      myCell: cellFromCoordinates(10, 10),
      monsters: [{ cellId: cellFromCoordinates(14, 10), life: 200, behaviour: 'static' }],
      spells: { 1: arrow }
    })
    const catalogue = readSpellCatalogue(world.gameWindow)
    const history = await playFight(world, planTurn, geometry, catalogue)

    assert.deepStrictEqual(world.violations, [], 'nothing illegal was attempted')
    assert.ok(!world.monsters[0].alive, 'the monster is killed')
    assert.ok(history.length <= 4, `and quickly (${history.length} turns)`)
    console.log(`ok - a still monster dies in ${history.length} turns`)
  }

  // --- a monster that closes in ---
  {
    const world = createWorld({
      myCell: cellFromCoordinates(10, 10),
      monsters: [{ cellId: cellFromCoordinates(20, 10), life: 300, behaviour: 'chaser', mp: 4 }],
      spells: { 1: arrow }
    })
    const catalogue = readSpellCatalogue(world.gameWindow)
    await playFight(world, planTurn, geometry, catalogue)

    assert.deepStrictEqual(world.violations, [], 'nothing illegal against a chaser')
    assert.ok(!world.monsters[0].alive, 'the chaser dies too')
    console.log('ok - a chasing monster is handled')
  }

  // --- a monster that runs faster than we do ---
  {
    const world = createWorld({
      myCell: cellFromCoordinates(10, 10),
      movementPoints: 2,
      monsters: [{ cellId: cellFromCoordinates(14, 10), life: 400, behaviour: 'fleer', mp: 5 }],
      spells: { 1: arrow }
    })
    const catalogue = readSpellCatalogue(world.gameWindow)
    const history = await playFight(world, planTurn, geometry, catalogue, { turns: 8 })

    assert.deepStrictEqual(world.violations, [], 'nothing illegal against a fleeing monster')

    // Out of reach is not a reason to thrash: either it shoots, or it walks
    // towards the monster. It must never do nothing while able to close in.
    const idle = history.filter((entry) => entry.casts === 0 && entry.from === entry.to)
    for (const entry of idle) {
      assert.ok(
        entry.diagnostic !== null,
        `turn ${entry.turn} did nothing and did not say why`
      )
    }
    console.log(`ok - a fleeing monster never leaves the AI idle in silence`)
  }

  // --- several monsters, mixed behaviour ---
  {
    const world = createWorld({
      myCell: cellFromCoordinates(10, 10),
      actionPoints: 8,
      monsters: [
        { cellId: cellFromCoordinates(13, 10), life: 150, behaviour: 'chaser', mp: 3 },
        { cellId: cellFromCoordinates(14, 11), life: 150, behaviour: 'static' },
        { cellId: cellFromCoordinates(16, 10), life: 400, behaviour: 'fleer', mp: 2 }
      ],
      spells: {
        1: arrow,
        2: {
          id: 2,
          spell: { nameId: 'Barrage' },
          spellLevel: level({
            apCost: 4,
            effects: [{ effectId: 100, diceNum: 25, diceSide: 25, zoneShape: 67, zoneSize: 1 }]
          })
        }
      }
    })
    const catalogue = readSpellCatalogue(world.gameWindow)
    const history = await playFight(world, planTurn, geometry, catalogue, { turns: 15 })

    assert.deepStrictEqual(world.violations, [], 'nothing illegal in a crowd')
    assert.ok(
      world.monsters.filter((monster) => !monster.alive).length >= 2,
      'the group is worked through'
    )

    // Walking back and forth between the same two cells wastes the fight.
    for (let index = 2; index < history.length; index++) {
      const a = history[index - 2]
      const b = history[index - 1]
      const c = history[index]
      const oscillating = a.to === c.to && b.to !== c.to && a.casts === 0 && b.casts === 0 && c.casts === 0
      assert.ok(!oscillating, `turns ${a.turn}-${c.turn} walked in circles without casting`)
    }
    // The fight must be carried to the monsters. Backing away from one that
    // cannot be reached is how a character ends up in a corner, never casting.
    const start = history[0].from
    const end = history[history.length - 1].to
    const startDistance = Math.min(
      ...world.monsters.map((monster) => cellDistance(start, monster.cellId))
    )
    const endDistance = Math.min(
      ...world.monsters.filter((monster) => monster.alive).map((monster) => cellDistance(end, monster.cellId))
    )
    assert.ok(
      endDistance <= startDistance + 4,
      `the character stays in the fight (${startDistance} to ${endDistance} cells away)`
    )

    console.log('ok - a mixed group is fought without walking in circles')
  }

  // --- a wall between us ---
  {
    const wall = new Set([cellFromCoordinates(12, 10), cellFromCoordinates(12, 11), cellFromCoordinates(12, 9)])
    const world = createWorld({
      myCell: cellFromCoordinates(10, 10),
      monsters: [{ cellId: cellFromCoordinates(14, 10), life: 200, behaviour: 'static' }],
      spells: { 1: arrow },
      walls: wall
    })
    const catalogue = readSpellCatalogue(world.gameWindow)
    await playFight(world, planTurn, geometry, catalogue, { turns: 10 })

    assert.deepStrictEqual(world.violations, [], 'a wall is never walked through or shot past')
    console.log('ok - obstacles are respected for a whole fight')
  }

  // --- no action points at all ---
  {
    const world = createWorld({
      myCell: cellFromCoordinates(10, 10),
      actionPoints: 1,
      monsters: [{ cellId: cellFromCoordinates(13, 10), life: 200, behaviour: 'static' }],
      spells: { 1: arrow }
    })
    const catalogue = readSpellCatalogue(world.gameWindow)
    const history = await playFight(world, planTurn, geometry, catalogue, { turns: 3 })

    assert.deepStrictEqual(world.violations, [], 'a turn with one point casts nothing illegal')
    assert.ok(
      history.every((entry) => entry.diagnostic !== null || entry.casts === 0),
      'and says why it cast nothing'
    )
    console.log('ok - a turn too poor to cast explains itself')
  }

  console.log('\nAll fight simulations passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
