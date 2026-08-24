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

/** How long a range buff holds, as a bow mastery does. */
const BUFF_TURNS = 2

function createWorld(options) {
  const {
    myCell,
    actionPoints = 6,
    movementPoints = 3,
    monsters = [],
    spells = {},
    walls = new Set(),
    characteristics = {}
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
      resists: monster.resists ?? {},
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
        movementPoints: entity.mp ?? 0,
        range: entity.rangeBonus ?? 0,
        ...(entity.resists ?? {})
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
        characters: { mainCharacter: { spellData: { spells }, characteristics } }
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
function applyPlan(world, plan, geometry, catalogue, damage) {
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

    // The catalogue was read unbuffed: a boostable spell reaches as far as
    // the character's current Portée, which a buff may have raised this turn.
    const range = spell.range + (spell.rangeBoostable ? (world.me.rangeBonus ?? 0) : 0)
    const distance = cellDistance(world.me.cellId, action.cellId)
    if (distance > range || distance < spell.minRange) {
      world.violations.push(
        `turn ${world.turn}: cast ${spell.name} at ${distance} cells, range ${spell.minRange}-${range}`
      )
      continue
    }

    if (spell.needsLineOfSight && !hasLineOfSight(world.gameWindow, world.me.cellId, action.cellId)) {
      world.violations.push(`turn ${world.turn}: cast ${spell.name} with no line of sight`)
      continue
    }

    apLeft -= action.apCost
    world.castsThisTurn.push(action)

    if (spell.rangeBoost > 0) {
      world.me.rangeBonus = spell.rangeBoost
      world.me.rangeBoostUntil = world.turn + BUFF_TURNS
    }

    for (const hit of action.hits) {
      const monster = world.monsters.find((candidate) => candidate.id === hit)
      if (!monster || !monster.alive) {
        world.violations.push(`turn ${world.turn}: cast at a monster that is already dead`)
        continue
      }
      monster.life -= damage(world, spell, monster)
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
  const { turns = 12, keepDistance = true, canMove = true, damage = (_w, spell) => spell.damage } = options
  const lastCastTurn = new Map()
  const history = []

  for (let turn = 1; turn <= turns; turn++) {
    world.turn = turn
    if (turn > (world.me.rangeBoostUntil ?? 0)) world.me.rangeBonus = 0
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
    applyPlan(world, plan, geometry, catalogue, damage)
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
  await bundleModule(path.join(root, 'packages/renderer/src/scripts/damage.ts'))
  const { readDamageProfile, damageAgainst } = await import(
    `${pathToFileURL(path.join(tmpDir, 'damage.js')).href}?t=${Date.now()}`
  )
  // The referee hits as hard as the character really does: statistics and the
  // monster's own resistances, not the spell's printed dice.
  const hit = (world, spell, monster) =>
    damageAgainst(spell, { stats: monster.resists ?? {} }, readDamageProfile(world.gameWindow))

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

  // --- out of reach at the start of the fight ---
  // Seven cells away with a six-cell bow: the turn must close the gap, never
  // back away "to keep its distance" from a fight it cannot start.
  {
    const world = createWorld({
      myCell: cellFromCoordinates(10, 10),
      actionPoints: 8,
      movementPoints: 3,
      monsters: [
        { cellId: cellFromCoordinates(17, 10), life: 300, behaviour: 'static' },
        { cellId: cellFromCoordinates(18, 10), life: 300, behaviour: 'static' }
      ],
      spells: {
        1: {
          id: 1,
          spell: { nameId: 'Mastery' },
          spellLevel: level({ apCost: 2, range: 0, minCastInterval: 3, effects: [{ effectId: 128, diceNum: 30, diceSide: 30, zoneSize: 0 }] })
        },
        2: {
          id: 2,
          spell: { nameId: 'Barrage' },
          spellLevel: level({
            apCost: 4,
            range: 6,
            minRange: 1,
            effects: [{ effectId: 100, diceNum: 30, diceSide: 40, zoneShape: 67, zoneSize: 1 }]
          })
        },
        3: {
          id: 3,
          spell: { nameId: 'Concentration' },
          spellLevel: level({ apCost: 3, range: 4, effects: [{ effectId: 96, diceNum: 22, diceSide: 28, zoneSize: 0 }] })
        }
      }
    })

    const catalogue = readSpellCatalogue(world.gameWindow)
    const history = await playFight(world, planTurn, geometry, catalogue, { turns: 6 })

    assert.deepStrictEqual(world.violations, [], 'nothing illegal while closing the gap')

    const startDistance = cellDistance(cellFromCoordinates(10, 10), cellFromCoordinates(17, 10))
    const afterFirst = cellDistance(history[0].to, cellFromCoordinates(17, 10))
    assert.ok(
      afterFirst < startDistance,
      `the first turn closes in (${startDistance} to ${afterFirst} cells)`
    )

    // And the area spell is the one used on a pair standing together.
    const areaCasts = history.reduce((total, entry) => total + entry.casts, 0)
    assert.ok(areaCasts > 0, 'the fight is actually fought')
    assert.ok(
      world.monsters.some((monster) => !monster.alive),
      'and the pair starts falling'
    )
    console.log('ok - a fight out of reach is closed, not fled')
  }

  // --- a range buff must open the turn it is cast in ---
  // The reported bug: turn one cast the bow mastery and then stopped, because
  // the range it grants was dropped from the plan as soon as it was applied.
  {
    const world = createWorld({
      myCell: cellFromCoordinates(10, 10),
      actionPoints: 8,
      movementPoints: 0,
      monsters: [
        { cellId: cellFromCoordinates(18, 10), life: 150, behaviour: 'static', name: 'Piou Bleu' },
        { cellId: cellFromCoordinates(19, 10), life: 150, behaviour: 'static', name: 'Piou Vert' }
      ],
      spells: {
        1: {
          id: 1,
          spell: { nameId: 'Maitrise de l Arc' },
          spellLevel: level({
            apCost: 2,
            range: 0,
            minCastInterval: 3,
            effects: [{ effectId: 117, diceNum: 2, diceSide: 2, zoneSize: 0 }]
          })
        },
        2: {
          id: 2,
          spell: { nameId: 'Fleche de Barrage' },
          spellLevel: level({
            apCost: 4,
            range: 6,
            minRange: 1,
            rangeCanBeBoosted: true,
            effects: [{ effectId: 100, diceNum: 30, diceSide: 40, zoneShape: 67, zoneSize: 1 }]
          })
        },
        3: {
          id: 3,
          spell: { nameId: 'Fleche de Concentration' },
          spellLevel: level({
            apCost: 3,
            range: 4,
            rangeCanBeBoosted: true,
            effects: [{ effectId: 96, diceNum: 20, diceSide: 26, zoneSize: 0 }]
          })
        }
      }
    })

    const catalogue = readSpellCatalogue(world.gameWindow)
    const barrage = catalogue.find((spell) => spell.id === 2)
    const mastery = catalogue.find((spell) => spell.id === 1)
    assert.strictEqual(mastery.rangeBoost, 2, 'the mastery is read as a range buff')
    assert.ok(barrage.rangeBoostable, 'and the bow spell takes it')

    const history = await playFight(world, planTurn, geometry, catalogue, { turns: 8 })

    assert.deepStrictEqual(world.violations, [], 'nothing illegal while the buff is up')
    assert.ok(
      history[0].casts >= 2,
      `the buff opens the turn instead of ending it (${history[0].casts} cast(s) on turn 1)`
    )
    assert.ok(
      history[1].casts >= 2,
      `and the turn after spends its points on the hardest hitter (${history[1].casts} cast(s))`
    )
    assert.ok(
      world.monsters.every((monster) => !monster.alive),
      'and the pair goes down'
    )
    console.log('ok - a range buff is followed by the attack it makes possible')
  }

  // --- real conditions: a Crâ against a group of Pious ---
  // The spells are the ones off the game's own sheets: Barrage 4 AP, range
  // 1-6, straight line only, perpendicular bar, 26-29 earth; Concentration
  // 3 AP, range 2-4, boostable, cross, 20-22 earth; the two single-target
  // arrows in water and air. A strength character must reach for the earth
  // ones, and for the areas when the birds stand together.
  const craSpells = () => ({
    1: {
      id: 1,
      spell: { nameId: 'Maîtrise de l Arc' },
      spellLevel: level({
        apCost: 2,
        range: 0,
        minCastInterval: 3,
        effects: [{ effectId: 117, diceNum: 2, diceSide: 2, zoneSize: 0 }]
      })
    },
    2: {
      id: 2,
      spell: { nameId: 'Flèche de Barrage' },
      spellLevel: level({
        apCost: 4,
        range: 6,
        minRange: 1,
        castInLine: true,
        maxCastPerTurn: 2,
        effects: [
          { effectId: 97, diceNum: 26, diceSide: 29, zoneShape: 84, zoneSize: 1 },
          { effectId: 5, diceNum: 1, zoneShape: 84, zoneSize: 1 }
        ]
      })
    },
    3: {
      id: 3,
      spell: { nameId: 'Flèche de Concentration' },
      spellLevel: level({
        apCost: 3,
        range: 4,
        minRange: 2,
        rangeCanBeBoosted: true,
        maxCastPerTurn: 2,
        maxCastPerTarget: 1,
        effects: [
          { effectId: 97, diceNum: 20, diceSide: 22, zoneShape: 43, zoneSize: 1 },
          { effectId: 7, diceNum: 1, zoneShape: 43, zoneSize: 1 }
        ]
      })
    },
    4: {
      id: 4,
      spell: { nameId: 'Flèche de Transfusion' },
      spellLevel: level({
        apCost: 3,
        range: 8,
        rangeCanBeBoosted: true,
        effects: [
          { effectId: 98, diceNum: 16, diceSide: 18, zoneSize: 0 },
          { effectId: 108, diceNum: 8, diceSide: 10, zoneSize: 0 }
        ]
      })
    },
    5: {
      id: 5,
      spell: { nameId: 'Flèche Aveuglante' },
      spellLevel: level({
        apCost: 3,
        range: 7,
        rangeCanBeBoosted: true,
        effects: [{ effectId: 99, diceNum: 14, diceSide: 17, zoneSize: 0 }]
      })
    }
  })

  const strengthCra = {
    strength: { base: 50, additionnal: 100, objectsAndMountBonus: 60 },
    intelligence: { base: 0 },
    chance: { base: 0 },
    agility: { base: 0, objectsAndMountBonus: 20 }
  }

  const pious = (cells, over = {}) =>
    cells.map((cellId, index) => ({
      cellId,
      life: 55,
      behaviour: 'static',
      name: ['Piou Bleu', 'Piou Rouge', 'Piou Jaune'][index] ?? `Piou ${index}`,
      ...over
    }))

  {
    const world = createWorld({
      myCell: cellFromCoordinates(10, 10),
      actionPoints: 8,
      movementPoints: 3,
      characteristics: strengthCra,
      spells: craSpells(),
      monsters: pious([
        cellFromCoordinates(14, 10),
        cellFromCoordinates(15, 10),
        cellFromCoordinates(15, 11)
      ])
    })

    const catalogue = readSpellCatalogue(world.gameWindow)
    const profile = readDamageProfile(world.gameWindow)
    const of = (id) => catalogue.find((spell) => spell.id === id)
    const target = { stats: {} }

    assert.ok(
      damageAgainst(of(2), target, profile) > damageAgainst(of(5), target, profile),
      'the earth arrow outdamages the air one on a strength character'
    )
    assert.strictEqual(of(2).zone.shape, 'perpendicular', 'Barrage covers a bar')
    assert.strictEqual(of(3).zone.shape, 'cross', 'Concentration covers a cross')

    const history = await playFight(world, planTurn, geometry, catalogue, { turns: 6, damage: hit })
    assert.deepStrictEqual(world.violations, [], 'a Piou fight breaks no rule')

    const turnsTaken = history.filter((entry) => entry.casts > 0).length
    assert.ok(
      world.monsters.every((monster) => !monster.alive),
      'the group is wiped out'
    )
    assert.ok(turnsTaken <= 2, `and it takes two turns at most (took ${turnsTaken})`)
    console.log(`ok - three Pious die in ${turnsTaken} turn(s) of earth areas`)
  }

  // The same birds, resisting earth: the choice must follow the resistance,
  // not the printed dice.
  {
    const world = createWorld({
      myCell: cellFromCoordinates(10, 10),
      actionPoints: 8,
      movementPoints: 3,
      characteristics: strengthCra,
      spells: craSpells(),
      monsters: pious([cellFromCoordinates(13, 10)], {
        life: 300,
        resists: { earthElementResistPercent: 95 }
      })
    })

    const catalogue = readSpellCatalogue(world.gameWindow)
    const plan = planTurn(world.gameWindow, {
      turn: 1,
      actionPoints: 8,
      movementPoints: 3,
      elements: [],
      lastCastTurn: new Map(),
      canMove: true,
      keepDistance: true
    })

    assert.ok(plan.casts.length > 0, 'a resistant monster is still fought')
    assert.ok(
      plan.casts.every((cast) => cast.spellId !== 2 && cast.spellId !== 3),
      'but not with the earth spells it shrugs off'
    )
    console.log('ok - resistances, not dice, pick the spell')
  }

  // An element left unticked disables spells; the plan has to say which.
  {
    const world = createWorld({
      myCell: cellFromCoordinates(10, 10),
      actionPoints: 8,
      movementPoints: 3,
      characteristics: strengthCra,
      spells: craSpells(),
      monsters: pious([cellFromCoordinates(14, 10), cellFromCoordinates(15, 10)])
    })

    const plan = planTurn(world.gameWindow, {
      turn: 1,
      actionPoints: 8,
      movementPoints: 3,
      elements: ['water', 'air'],
      lastCastTurn: new Map(),
      canMove: true,
      keepDistance: true
    })

    assert.ok(
      plan.casts.every((cast) => cast.spellId !== 2 && cast.spellId !== 3),
      'the unticked element really is filtered out'
    )
    assert.ok(
      plan.leftOut.some((line) => line.includes('Barrage') && line.includes('Elements')),
      `and the turn says so (${plan.leftOut.join(' | ')})`
    )
    console.log('ok - an unticked element is reported, not silently obeyed')
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
