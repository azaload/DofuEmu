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
