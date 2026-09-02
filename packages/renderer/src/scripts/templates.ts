import type { AutomationScript, ScriptTarget } from '@dofemu/shared'

export interface ScriptTemplate {
  id: string
  name: string
  description: string
  target: ScriptTarget
  loop: boolean
  loopDelayMs: number
  source: string
}

export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
  {
    id: 'blank',
    name: 'Blank script',
    description: 'Empty starting point.',
    target: 'active-tab',
    loop: false,
    loopDelayMs: 0,
    source: `// Everything happens through the injected \`api\` object.
// Press "API reference" above for the full list of helpers.

api.log('Running on', api.character().name ?? 'unknown character')
await api.wait(1000)
`
  },
  {
    id: 'patrol',
    name: 'Map patrol',
    description: 'Walks a fixed path of map changes back and forth.',
    target: 'active-tab',
    loop: true,
    loopDelayMs: 2000,
    source: `// A path is a list of map-change directions:
// top / bottom / left / right (up, down, north, south... also work).
const path = ['right', 'right', 'bottom']
const back = [...path].reverse().map((d) => ({ right: 'left', left: 'right', top: 'bottom', bottom: 'top' })[d])

api.log('Patrol lap', api.iteration, 'from map', api.mapId())

await api.movePath(path)
await api.waitRandom(800, 2200)
await api.movePath(back)
`
  },
  {
    id: 'travel',
    name: 'Travel to coordinates',
    description: 'Walks map by map towards a [x, y] world position.',
    target: 'active-tab',
    loop: false,
    loopDelayMs: 0,
    source: `const target = { x: 2, y: -2 }

const from = api.map()
api.log('Travelling from', \`[\${from.x}, \${from.y}]\`, 'to', \`[\${target.x}, \${target.y}]\`)

await api.travelTo(target.x, target.y)

api.log('Arrived on map', api.mapId())
`
  },
  {
    id: 'gather',
    name: 'Resource circuit',
    description: 'Harvests every available resource, then moves to the next map.',
    target: 'active-tab',
    loop: true,
    loopDelayMs: 3000,
    source: `const circuit = ['right', 'bottom', 'left', 'top']

for (const direction of circuit) {
  if (api.isInFight()) {
    api.log('In a fight, waiting for it to end')
    await api.waitUntil(() => !api.isInFight(), { timeout: 600000, interval: 2000 })
  }

  let harvested = 0
  while (await api.gather()) {
    harvested += 1
    await api.waitRandom(600, 1500)
  }

  api.log('Map', api.mapId(), '- harvested', harvested, 'resource(s)')
  await api.move(direction)
  await api.waitRandom(1000, 2500)
}
`
  },
  {
    id: 'attack-1-simple',
    name: 'Attack 1 — nearest group',
    description: 'The simplest test: attack the closest group on this map, and report what happened.',
    target: 'active-tab',
    loop: false,
    loopDelayMs: 0,
    source: `// Start here. Stand on a map with monsters and press Run.
const groups = api.monsters()
api.log(\`\${groups.length} group(s) on map \${api.mapId()}, my cell \${api.cellId()}\`)

if (groups.length === 0) api.stop('no monster group on this map')

const group = groups[0] // nearest first
api.log(\`Target: group \${group.id} on cell \${group.cellId}, size \${group.size}, level \${group.level}\`)

const started = await api.attack(group)
api.log(started ? 'FIGHT STARTED' : 'no fight started')

if (!started) {
  api.warn('Nothing worked — dumping what the client exposes:')
  api.inspect()
}
`
  },
  {
    id: 'attack-2-protocol',
    name: 'Attack 2 — network message only',
    description: 'Walks next to the group, then sends the attack message and nothing else.',
    target: 'active-tab',
    loop: false,
    loopDelayMs: 0,
    source: `const group = api.monsters()[0]
if (!group) api.stop('no monster group on this map')

// Stand next to the group first: the server refuses an attack from afar.
if (group.cellId !== null) {
  try {
    await api.attack(group, { approach: true, timeout: 1 })
  } catch (err) {
    api.warn('approach failed:', err)
  }
}

api.log('Sending GameRolePlayAttackMonsterRequestMessage for group', group.id)
api.send('GameRolePlayAttackMonsterRequestMessage', { monsterGroupId: group.id })

await api.wait(3000)
api.log(api.isInFight() ? 'FIGHT STARTED' : 'no fight — the message alone is not enough')
`
  },
  {
    id: 'attack-3-walk-into',
    name: 'Attack 3 — walk into the group',
    description: 'Asks the engine to walk onto the group cell, the way tapping a monster does.',
    target: 'active-tab',
    loop: false,
    loopDelayMs: 0,
    source: `const group = api.monsters()[0]
if (!group || group.cellId === null) api.stop('no monster group on this map')

api.log('Walking onto the group cell', group.cellId)

try {
  // It never truly arrives — the cell is taken — but the client may take over
  // and open its confirmation on the way.
  await api.moveToCell(group.cellId, { timeout: 6000 })
} catch (err) {
  api.log('walk ended:', err)
}

for (let i = 0; i < 6; i++) {
  await api.wait(500)
  if (api.isInFight()) break
}

api.log(api.isInFight() ? 'FIGHT STARTED' : 'no fight after walking in')
api.log('on screen:', api.closePopups().length === 0 ? '(no popup closed)' : 'popup closed')
`
  },
  {
    id: 'attack-4-probe',
    name: 'Attack 4 — probe the engine',
    description: 'Calls every engine member that looks like an attack, one by one, and says which one bites.',
    target: 'active-tab',
    loop: false,
    loopDelayMs: 0,
    source: `const group = api.monsters()[0]
if (!group) api.stop('no monster group on this map')

const iso = api.raw.isoEngine
const gui = api.raw.gui
const actors = (iso && iso.actorManager && iso.actorManager.actors) || {}
const actor = actors[String(group.id)] || actors[group.id]

api.log('actor found:', actor ? 'yes' : 'no')

function methodsOf(owner, label) {
  const found = []
  let current = owner
  for (let depth = 0; current && depth < 3; depth++) {
    for (const key of Object.getOwnPropertyNames(current)) {
      if (!/attack|monster|fight|tap|select|click/i.test(key)) continue
      try {
        if (typeof owner[key] === 'function') found.push({ owner, label, key })
      } catch (err) {}
    }
    current = Object.getPrototypeOf(current)
  }
  return found
}

const candidates = [
  ...methodsOf(iso, 'isoEngine'),
  ...methodsOf(iso && iso.actorManager, 'actorManager'),
  ...methodsOf(gui, 'gui')
]

api.log('candidates:', candidates.map((c) => c.label + '.' + c.key).join(', ') || 'none')

for (const candidate of candidates) {
  if (api.isInFight()) break

  for (const argument of [group.id, actor, { id: group.id }]) {
    if (api.isInFight()) break
    try {
      candidate.owner[candidate.key](argument)
      api.log('called', candidate.label + '.' + candidate.key, 'with', typeof argument)
      await api.wait(600)
      if (api.isInFight()) {
        api.log('FIGHT STARTED via', candidate.label + '.' + candidate.key)
        break
      }
    } catch (err) {}
  }
}

if (!api.isInFight()) {
  api.warn('none of them started a fight')
  api.inspect()
}
`
  },
  {
    id: 'hunt-circuit',
    name: 'Hunt: fight a map circuit',
    description:
      'Walks a chosen list of maps, attacks the monster groups that match the filters, and waits out each fight.',
    target: 'active-tab',
    loop: true,
    loopDelayMs: 5000,
    source: `// The maps to farm, in order. Walk to a map in game and read its
// coordinates at the top of the Scripts tab, then add them here.
const MAPS = [
  { x: 3, y: -5 },
  { x: 4, y: -5 }
]

// Which groups to attack. level is the sum of the levels of the whole group.
const FILTER = { minLevel: 1, maxLevel: 200, maxSize: 8 }

// Fights are played by the Combat AI (Settings -> Combat). Turn it on, or
// replace waitForFightEnd below with your own api.fight logic.
const FIGHT_TIMEOUT = 1800000

for (const spot of MAPS) {
  if (!api.isConnected()) {
    api.warn('Not in game yet, waiting for the character to be ready')
    await api.waitUntil(() => api.isConnected(), { timeout: 300000, interval: 3000 })
  }

  if (api.isInFight()) {
    await api.fight.waitForFightEnd({ timeout: FIGHT_TIMEOUT, interval: 2000 })
    await api.waitRandom(1000, 2000)
  }

  api.log('Heading to', \`[\${spot.x}, \${spot.y}]\`)
  await api.travelTo(spot.x, spot.y)

  let fights = 0
  let groups = api.monsters(FILTER)

  while (groups.length > 0) {
    const group = groups[0]
    api.log(\`Attacking a group of \${group.size} (level \${group.level}) on map \${api.mapId()}\`)

    if (!(await api.attack(group))) {
      api.warn('The attack did not start a fight, moving on')
      break
    }

    fights += 1
    await api.fight.waitForFightEnd({ timeout: FIGHT_TIMEOUT, interval: 2000 })

    // The results screen — and sometimes a level-up window — stay up until
    // dismissed, and block the next move.
    await api.waitRandom(1200, 2000)
    api.closePopups()
    await api.waitRandom(1200, 2000)
    api.closePopups()
    api.log('Fight over')

    groups = api.monsters(FILTER)
  }

  api.log(\`Map \${api.mapId()} done — \${fights} fight(s)\`)
  await api.waitRandom(1000, 2500)
}
`
  },
  {
    id: 'line-patrol-fight',
    name: 'Patrol a line and fight',
    description:
      'Walks back and forth along a row of maps, fighting every group it finds on the way.',
    target: 'active-tab',
    loop: true,
    loopDelayMs: 4000,
    source: `// Back and forth along one row of maps, fighting on every map.
const Y = -21
const FROM_X = -2
const TO_X = 7

// Which groups to attack. level is the sum of the levels of the whole group.
const FILTER = { minLevel: 1, maxLevel: 9999, maxSize: 8 }

// Fights are played by the Combat AI (Settings -> Combat).
const FIGHT_TIMEOUT = 1800000

async function settle() {
  if (!api.isConnected()) {
    api.warn('Not in game, waiting')
    await api.waitUntil(() => api.isConnected(), { timeout: 300000, interval: 3000 })
  }
  if (api.isInFight()) {
    await api.fight.waitForFightEnd({ timeout: FIGHT_TIMEOUT, interval: 2000 })
    await api.waitRandom(1200, 2000)
    api.closePopups()
  }
}

async function fightHere() {
  await settle()

  let groups = api.monsters(FILTER)
  api.log(\`Map \${api.mapId()}: \${groups.length} group(s)\`)

  while (groups.length > 0) {
    const group = groups[0]
    api.log(\`Attacking group \${group.id} (size \${group.size}, level \${group.level}) on cell \${group.cellId}\`)

    if (!(await api.attack(group))) {
      api.warn('No fight started, leaving this map')
      break
    }

    await api.fight.waitForFightEnd({ timeout: FIGHT_TIMEOUT, interval: 2000 })

    // The results screen, and sometimes a level-up window, block the next move.
    await api.waitRandom(1200, 2000)
    api.closePopups()
    await api.waitRandom(1200, 2000)
    api.closePopups()
    api.log('Fight over')

    groups = api.monsters(FILTER)
  }

  await api.waitRandom(800, 1800)
}

await settle()

const steps = Math.abs(TO_X - FROM_X)
const forward = TO_X >= FROM_X ? 'right' : 'left'
const backward = forward === 'right' ? 'left' : 'right'

if (api.map().x === null) {
  // This game build does not expose map coordinates: walk by direction
  // instead, starting from wherever the character stands.
  api.warn(\`No map coordinates on this build — patrolling \${steps} maps to the \${forward} and back\`)
  api.inspectMap()

  await fightHere()
  for (let step = 0; step < steps; step++) {
    await api.move(forward)
    await fightHere()
  }
  for (let step = 0; step < steps; step++) {
    await api.move(backward)
    await fightHere()
  }
} else {
  const outward = []
  for (let x = FROM_X; x <= TO_X; x++) outward.push(x)
  const route = [...outward, ...[...outward].reverse().slice(1)]

  api.log(\`Lap \${api.iteration}: [\${FROM_X}, \${Y}] -> [\${TO_X}, \${Y}] and back\`)

  for (const x of route) {
    const here = api.map()
    if (here.x !== x || here.y !== Y) {
      api.log(\`Travelling to [\${x}, \${Y}]\`)
      await api.travelTo(x, Y)
    }
    await fightHere()
  }
}
`
  },
  {
    id: 'follow-leader',
    name: 'Follow the leader',
    description:
      'Leader broadcasts every map change, followers reproduce it. Run it on the leader and on each follower.',
    target: 'all-tabs',
    loop: false,
    loopDelayMs: 0,
    source: `// Set this to the character that leads the group.
const LEADER = 'MyLeaderName'

const me = api.character().name
const isLeader = me === LEADER

if (isLeader) {
  api.log(me, 'is leading')
  api.on('CurrentMapMessage', (msg) => {
    api.broadcast('follow', { mapId: msg.mapId })
  })
} else {
  api.log(me, 'is following', LEADER)
  api.onBroadcast('follow', async (data) => {
    if (!data || !data.mapId || data.mapId === api.mapId()) return
    try {
      await api.changeMap(data.mapId)
    } catch (err) {
      api.warn('Could not follow:', err)
    }
  })
}

// Keep the run alive so the listeners stay attached.
await api.waitUntil(() => false, { timeout: 3600000, interval: 5000 }).catch(() => {})
`
  },
  {
    id: 'anti-afk',
    name: 'Anti-AFK',
    description: 'Small random moves on the current map at random intervals.',
    target: 'all-tabs',
    loop: true,
    loopDelayMs: 0,
    source: `if (api.isInFight()) {
  await api.waitUntil(() => !api.isInFight(), { timeout: 600000, interval: 5000 })
}

const cell = api.cellId()
if (cell !== null) {
  const nearby = [cell - 14, cell + 14, cell - 1, cell + 1].filter((c) => c >= 0 && c < 560)
  try {
    await api.moveToCell(api.pick(nearby), { timeout: 8000 })
  } catch (err) {
    api.warn('Move skipped:', err)
  }
}

await api.waitRandom(60000, 180000)
`
  },
  {
    id: 'combat-combo',
    name: 'Combat: spell combo',
    description: 'Casts a fixed spell combo on a target every turn, then passes the turn.',
    target: 'active-tab',
    loop: true,
    loopDelayMs: 500,
    source: `// Spell ids of the combo, cast in order every turn.
// The Combat tab does the same thing without writing code — this template is
// the starting point when you want custom logic (conditions, positioning...).
const COMBO = [161, 165]
const TARGET = 'nearest' // nearest | weakest | strongest | first

await api.fight.waitForFight({ timeout: 600000 })
await api.fight.waitForTurn({ timeout: 600000 })

for (const spellId of COMBO) {
  if (!api.fight.isMyTurn()) break

  const target = api.fight.target(TARGET)
  if (!target) {
    api.log('No enemy left')
    break
  }

  const cast = await api.fight.cast(spellId, target)
  api.log(cast ? \`Cast \${spellId} on \${target.name ?? target.id}\` : \`Spell \${spellId} refused\`)
  await api.waitRandom(600, 1200)
}

api.fight.endTurn()
await api.fight.waitForTurnEnd({ timeout: 600000 })
`
  },
  {
    id: 'fight-watch',
    name: 'Fight watcher',
    description: 'Logs fight starts and stops the other scripts when one begins.',
    target: 'all-tabs',
    loop: false,
    loopDelayMs: 0,
    source: `api.on('GameFightStartingMessage', () => {
  api.log('Fight starting on map', api.mapId())
  api.broadcast('fight', { tabId: api.tabId, mapId: api.mapId() })
})

api.on('GameFightEndMessage', () => api.log('Fight finished'))

await api.waitUntil(() => false, { timeout: 3600000, interval: 5000 }).catch(() => {})
`
  }
]

export function scriptFromTemplate(template: ScriptTemplate): Omit<AutomationScript, 'id'> {
  const now = Date.now()
  return {
    name: template.name,
    description: template.description,
    source: template.source,
    target: template.target,
    loop: template.loop,
    loopDelayMs: template.loopDelayMs,
    createdAt: now,
    updatedAt: now
  }
}
