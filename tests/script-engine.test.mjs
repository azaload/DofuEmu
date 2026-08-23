import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { build } from 'vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const tmpDir = path.join(root, 'tests/.tmp')
const bundlePath = path.join(tmpDir, 'engine.js')
const combatBundlePath = path.join(tmpDir, 'combat-ai.js')

/** Same grid maths as the app, to spend the right number of MP in the stub. */
function cellGridDistance(from, to) {
  const point = (cellId) => {
    const row = Math.floor(cellId / 14)
    const col = cellId % 14
    return { x: col + Math.floor((row + 1) / 2), y: Math.floor(row / 2) - col }
  }
  const a = point(from)
  const b = point(to)
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
}

const MAP_A = 1000
const MAP_B = 1001
const EXIT_CELL_RIGHT = 293

async function bundleModule(entry) {
  fs.mkdirSync(tmpDir, { recursive: true })
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

async function bundleEngine() {
  fs.mkdirSync(tmpDir, { recursive: true })
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
      lib: {
        entry: path.join(root, 'packages/renderer/src/scripts/engine.ts'),
        formats: ['es']
      }
    }
  })
  return import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`)
}

/** Minimal stand-in for the game window the scripts drive. */
function createFakeGameWindow() {
  const listeners = new Map()
  const sent = []

  const closedWindows = []
  const moves = []
  const cells = {}
  cells[EXIT_CELL_RIGHT] = { mapChangeData: 1 }

  const state = {
    mapId: MAP_A,
    cellId: 100,
    sent,
    emit: (event, payload) => {
      for (const handler of listeners.get(event) ?? []) handler(payload)
    }
  }

  const connectionManager = {
    on: (event, handler) => {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
    removeListener: (event, handler) => {
      listeners.set(event, (listeners.get(event) ?? []).filter((cb) => cb !== handler))
    }
  }

  const fighters = [
    { id: 7, data: { teamId: 0, alive: true, disposition: { cellId: 280 }, stats: { lifePoints: 500, maxLifePoints: 500, actionPoints: 6, movementPoints: 3 }, name: 'Tester' } },
    { id: 20, data: { teamId: 1, alive: true, disposition: { cellId: 294 }, stats: { lifePoints: 120, maxLifePoints: 200 }, name: 'Close' } },
    { id: 21, data: { teamId: 1, alive: true, disposition: { cellId: 350 }, stats: { lifePoints: 40, maxLifePoints: 200 }, name: 'Weak' } }
  ]

  const attackButton = {
    tagName: 'DIV',
    className: 'greenButton attackButton',
    textContent: 'Attaquer',
    offsetParent: {},
    clicked: 0,
    click() {
      this.clicked += 1
      setTimeout(() => {
        gameWindow.gui.fightManager.isFightStarted = true
        gameWindow.gui.playerData.isFighting = true
        state.emit('GameFightStartingMessage', {})
      }, 5)
    },
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 80, height: 24 })
  }

  const gameWindow = {
    document: {
      querySelectorAll: () => (state.attackButtonVisible ? [attackButton] : [])
    },
    dofus: {
      connectionManager,
      sendMessage: (name, data) => {
        sent.push({ name, data })
        if (name === 'GameMapMovementRequestMessage') {
          // Decode the path the way the server would, and walk it.
          const path = (data.keyMovements ?? []).map((key) => key & 0xfff)
          const destination = path[path.length - 1]
          if (destination !== undefined) state.moves.push(destination)
          if (destination !== undefined && !state.serverRefusesMoves) {
            const landing = state.walkLimit ? state.walkLimit(destination) : destination
            setTimeout(() => {
              const spent = cellGridDistance(fighters[0].data.disposition.cellId, landing)
              state.cellId = landing
              gameWindow.isoEngine.actorManager.userActor.cellId = landing
              fighters[0].data.disposition.cellId = landing
              fighters[0].data.stats.movementPoints = Math.max(
                0,
                fighters[0].data.stats.movementPoints - spent
              )
            }, 5)
          }
        }
        if (name === 'GameRolePlayAttackMonsterRequestMessage') {
          setTimeout(() => {
            gameWindow.gui.fightManager.isFightStarted = true
            gameWindow.gui.playerData.isFighting = true
            state.emit('GameFightStartingMessage', { monsterGroupId: data.monsterGroupId })
          }, 5)
        }
        if (name === 'GameActionFightCastRequestMessage') {
          setTimeout(() => state.emit('GameActionFightSpellCastMessage', { sourceId: 7, spellId: data.spellId }), 5)
        }
        if (name === 'ChangeMapMessage') {
          setTimeout(() => {
            state.mapId = data.mapId
            gameWindow.isoEngine.mapRenderer.mapId = data.mapId
            gameWindow.isoEngine.mapRenderer.map = buildMap(data.mapId)
            state.emit('CurrentMapMessage', { mapId: data.mapId })
          }, 5)
        }
      }
    },
    gui: {
      // Swallows every argument and does nothing, like the minified build.
      // Present but useless, like the minified build. They throw when a test
      // does not want them, so the API treats them as absent.
      openContextualMenu: () => {
        if (!state.noopAttackMethods) throw new Error('not available')
      },
      selectActor: () => {
        if (!state.noopAttackMethods) throw new Error('not available')
      },
      isConnected: () => true,
      playerData: {
        characterBaseInformations: { id: 7, name: 'Tester', level: 42 },
        isFighting: false,
        characters: {
          mainCharacter: {
            spellData: {
              spells: {
                161: { id: 161, spell: { nameId: 'Pressure' }, level: 5 },
                165: { id: 165, spell: { nameId: 'Bramble' }, level: 4 }
              }
            }
          }
        }
      },
      fightManager: { isFightStarted: false, fighters },
      windowsManager: {
        openedWindows: {
          fightEnd: { id: 'fightEnd', openState: true },
          levelUp: { id: 'levelUp', openState: true },
          inventory: { id: 'inventory', openState: true }
        },
        close: (id) => {
          closedWindows.push(id)
          delete gameWindow.gui.windowsManager.openedWindows[id]
        }
      },
      on: connectionManager.on
    },
    isoEngine: {
      mapRenderer: {
        mapId: MAP_A,
        map: buildMap(MAP_A),
        interactiveElements: {},
        isWalkable: () => true
      },
      actorManager: {
        userActor: { cellId: 100 },
        actors: {
          // A player: no staticInfos, must be ignored.
          '900': { id: 900, data: { disposition: { cellId: 120 } } },
          '-1': {
            id: -1,
            data: {
              contextualId: -1,
              disposition: { cellId: 300 },
              staticInfos: {
                mainCreatureLightInfos: { level: 30 },
                underlings: [{ level: 25 }, { level: 20 }]
              }
            }
          },
          '-2': {
            id: -2,
            data: {
              contextualId: -2,
              disposition: { cellId: 114 },
              staticInfos: {
                mainCreatureLightInfos: { level: 60 },
                underlings: [{ level: 55 }, { level: 50 }, { level: 45 }]
              }
            }
          }
        }
      },
      // Named like a build that does NOT expose moveTo, so the API has to
      // discover the working entry point.
      goToCell: (cellId) => {
        if (state.disableMovement) return
        state.moves.push(cellId)
        // state.walkLimit caps how far the engine actually walks, the way the
        // real one stops short when the path is blocked.
        const landing = state.walkLimit ? state.walkLimit(cellId) : cellId
        setTimeout(() => {
          const spent = cellGridDistance(fighters[0].data.disposition.cellId, landing)
          state.cellId = landing
          gameWindow.isoEngine.actorManager.userActor.cellId = landing
          fighters[0].data.disposition.cellId = landing
          fighters[0].data.stats.movementPoints = Math.max(
            0,
            fighters[0].data.stats.movementPoints - spent
          )
        }, 5)
      }
    }
  }

  function buildMap(mapId) {
    return {
      id: mapId,
      posX: mapId === MAP_A ? 3 : 4,
      posY: -5,
      cells,
      topNeighbourId: -1,
      bottomNeighbourId: -1,
      leftNeighbourId: mapId === MAP_B ? MAP_A : -1,
      rightNeighbourId: mapId === MAP_A ? MAP_B : -1
    }
  }

  state.closedWindows = closedWindows
  state.moves = moves
  state.attackButton = attackButton
  state.attackButtonVisible = true
  state.endFight = () => {
    gameWindow.gui.fightManager.isFightStarted = false
    gameWindow.gui.playerData.isFighting = false
    state.emit('GameFightEndMessage', {})
  }
  state.fighters = fighters
  state.startFight = () => {
    gameWindow.gui.fightManager.isFightStarted = true
    gameWindow.gui.playerData.isFighting = true
  }
  state.mpPerTurn = 3
  state.startTurn = (fighterId) => {
    if (fighterId === 7) fighters[0].data.stats.movementPoints = state.mpPerTurn
    state.emit('GameFightTurnStartMessage', { id: fighterId })
    state.emit('GameFightTurnStartPlayingMessage', { id: fighterId })
  }
  /** Turn start without the "you may play" message, to test the wait. */
  state.startTurnPending = (fighterId) =>
    state.emit('GameFightTurnStartMessage', { id: fighterId })
  state.setPlayable = (fighterId) =>
    state.emit('GameFightTurnStartPlayingMessage', { id: fighterId })

  return { gameWindow, state }
}

const settings = {
  enabled: true,
  humanDelays: false,
  minActionDelayMs: 0,
  maxActionDelayMs: 0,
  stopOnFight: true,
  maxRuntimeMinutes: 5
}

function makeScript(overrides = {}) {
  return {
    id: 'script-1',
    name: 'Test script',
    description: '',
    source: '',
    target: 'active-tab',
    loop: false,
    loopDelayMs: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function makeHooks() {
  const logs = []
  const statuses = []
  return {
    logs,
    statuses,
    hooks: {
      onStatus: (run) => statuses.push(run.status),
      onLog: (level, message) => logs.push(`${level}: ${message}`)
    }
  }
}

async function run(ScriptRunner, source, extra = {}, prepare) {
  const { gameWindow, state } = createFakeGameWindow()
  prepare?.(state)
  const { logs, statuses, hooks } = makeHooks()
  const runner = new ScriptRunner({
    script: makeScript({ source, ...extra }),
    tabId: 'tab-1',
    gameWindow,
    settings,
    hooks
  })
  const result = await runner.run()
  return { result, logs, statuses, state, runner }
}

async function testSimpleRun(ScriptRunner) {
  const { result, logs } = await run(ScriptRunner, `
    api.log('character is', api.character().name)
    api.log('map is', api.mapId())
    await api.wait(5)
  `)

  assert.strictEqual(result.status, 'done', 'a plain script should finish')
  assert.strictEqual(result.iteration, 1)
  assert.ok(logs.some((line) => line.includes('character is Tester')), 'api.character() should read the game window')
  assert.ok(logs.some((line) => line.includes(`map is ${MAP_A}`)), 'api.mapId() should read the map renderer')
  console.log('ok - simple run')
}

async function testMove(ScriptRunner) {
  const { result, state } = await run(ScriptRunner, `await api.move('right')`)

  assert.strictEqual(result.status, 'done', `move should succeed, got ${result.error ?? ''}`)
  assert.strictEqual(state.cellId, EXIT_CELL_RIGHT, 'the character walks to the map-change cell first')
  assert.deepStrictEqual(
    state.sent.map((message) => message.name),
    ['ChangeMapMessage'],
    'a single ChangeMapMessage is sent'
  )
  assert.strictEqual(state.sent[0].data.mapId, MAP_B, 'it targets the right neighbour')
  assert.strictEqual(state.mapId, MAP_B, 'the run waits until the new map is loaded')
  console.log('ok - map change')
}

async function testTravel(ScriptRunner) {
  const { result, state } = await run(ScriptRunner, `await api.travelTo(4, -5)`)
  assert.strictEqual(result.status, 'done', `travel should succeed, got ${result.error ?? ''}`)
  assert.strictEqual(state.mapId, MAP_B, 'travelTo walks towards the target coordinates')
  console.log('ok - travel to coordinates')
}

async function testLoopAndStop(ScriptRunner) {
  const { gameWindow } = createFakeGameWindow()
  const { logs, hooks } = makeHooks()
  const runner = new ScriptRunner({
    script: makeScript({ source: `api.log('tick', api.iteration); await api.wait(10)`, loop: true, loopDelayMs: 0 }),
    tabId: 'tab-1',
    gameWindow,
    settings,
    hooks
  })

  const pending = runner.run()
  setTimeout(() => runner.stop('Stopped by test'), 60)
  const result = await pending

  assert.strictEqual(result.status, 'stopped', 'stopping a loop marks the run stopped')
  assert.ok(result.iteration > 1, `the loop should iterate more than once, got ${result.iteration}`)
  assert.ok(logs.some((line) => line.includes('Stopped by test')), 'the stop reason is logged')
  console.log('ok - loop and stop')
}

async function testRuntimeError(ScriptRunner) {
  const { result } = await run(ScriptRunner, `await api.move('top')`)
  assert.strictEqual(result.status, 'error', 'moving towards a missing neighbour fails the run')
  assert.match(result.error ?? '', /no top neighbour/i)
  console.log('ok - runtime error')
}

async function testSyntaxError(ScriptRunner) {
  const { result, logs } = await run(ScriptRunner, `this is not javascript(`)
  assert.strictEqual(result.status, 'error', 'a syntax error fails before running')
  assert.ok(logs.some((line) => line.startsWith('error: Syntax error')), 'the syntax error is logged')
  console.log('ok - syntax error')
}

async function testApiStop(ScriptRunner) {
  const { result, logs } = await run(ScriptRunner, `api.log('before'); api.stop('done early'); api.log('after')`)
  assert.strictEqual(result.status, 'stopped')
  assert.ok(!logs.some((line) => line.includes('after')), 'api.stop() interrupts the script')
  console.log('ok - api.stop')
}

async function testListenersCleanedUp(ScriptRunner) {
  const { gameWindow, state } = createFakeGameWindow()
  const { hooks } = makeHooks()
  const runner = new ScriptRunner({
    script: makeScript({ source: `api.on('CurrentMapMessage', () => { globalThis.__hits = (globalThis.__hits ?? 0) + 1 })` }),
    tabId: 'tab-1',
    gameWindow,
    settings,
    hooks
  })

  await runner.run()
  state.emit('CurrentMapMessage', { mapId: MAP_B })
  assert.strictEqual(globalThis.__hits, undefined, 'listeners registered by a script are removed when it ends')
  console.log('ok - listeners cleaned up')
}

async function testFightCombo(ScriptRunner) {
  const { gameWindow, state } = createFakeGameWindow()
  const { logs, hooks } = makeHooks()
  state.startFight()

  const runner = new ScriptRunner({
    script: makeScript({
      source: `
        await api.fight.waitForTurn({ timeout: 5000, interval: 50 })
        for (const spellId of [161, 165]) {
          const target = api.fight.target('nearest')
          const ok = await api.fight.cast(spellId, target)
          api.log('cast', spellId, 'on', target.name, ok)
        }
        api.fight.endTurn()
      `
    }),
    tabId: 'tab-1',
    gameWindow,
    settings,
    hooks
  })

  const pending = runner.run()
  setTimeout(() => state.startTurn(7), 40)
  const result = await pending

  assert.strictEqual(result.status, 'done', `combo should finish, got ${result.error ?? ''}`)

  const casts = state.sent.filter((message) => message.name === 'GameActionFightCastRequestMessage')
  assert.deepStrictEqual(casts.map((c) => c.data.spellId), [161, 165], 'both spells are cast in order')
  assert.strictEqual(casts[0].data.cellId, 294, 'the nearest enemy cell is targeted')
  assert.ok(
    state.sent.some((message) => message.name === 'GameFightTurnFinishMessage'),
    'the turn is passed after the combo'
  )
  assert.ok(logs.some((line) => line.includes('cast 161 on Close true')), 'the cast is confirmed')
  console.log('ok - fight combo')
}

async function testTargetStrategies(ScriptRunner) {
  const { gameWindow, state } = createFakeGameWindow()
  const { logs, hooks } = makeHooks()
  state.startFight()

  const runner = new ScriptRunner({
    script: makeScript({
      source: `
        api.log('nearest', api.fight.target('nearest').name)
        api.log('weakest', api.fight.target('weakest').name)
        api.log('spells', api.fight.spells().map((s) => s.id).join(','))
        api.log('enemies', api.fight.enemies().length)
      `
    }),
    tabId: 'tab-1',
    gameWindow,
    settings,
    hooks
  })

  const result = await runner.run()
  assert.strictEqual(result.status, 'done')
  assert.ok(logs.some((line) => line.includes('nearest Close')), 'nearest picks the closest cell')
  assert.ok(logs.some((line) => line.includes('weakest Weak')), 'weakest picks the lowest life')
  assert.ok(logs.some((line) => line.includes('spells 161,165')), 'the spell list is read')
  assert.ok(logs.some((line) => line.includes('enemies 2')), 'only the other team counts as enemies')
  console.log('ok - fight targeting')
}

async function testMonsterHunt(ScriptRunner) {
  const { result, logs, state } = await run(
    ScriptRunner,
    `
      const all = api.monsters()
      api.log('groups', all.length, 'first', all[0].id, 'level', all[0].level, 'size', all[0].size)

      const small = api.monsters({ maxLevel: 100 })
      api.log('small', small.map((g) => g.id).join(','))

      const started = await api.attack(all[0])
      api.log('fight started', started)
    `
  )

  assert.strictEqual(result.status, 'done', `hunt should finish, got ${result.error ?? ''}`)
  assert.ok(logs.some((line) => line.includes('groups 2 ')), 'only monster groups are listed')
  assert.ok(
    logs.some((line) => line.includes('first -2 level 210 size 4')),
    'the nearest group comes first, with summed levels and group size'
  )
  assert.ok(logs.some((line) => line.includes('small -1')), 'the level filter excludes big groups')

  // The group on cell 114 is already next to us: no walking needed.
  assert.strictEqual(state.moves.length, 0, 'no move when already next to the group')
  assert.ok(state.attackButton.clicked > 0, 'the attack is requested through the game flow')
  assert.ok(logs.some((line) => line.includes('fight started true')), 'the fight start is awaited')
  console.log('ok - monster hunt')
}

async function testAttackUsesTheGameFlow(ScriptRunner) {
  const { result, logs, state } = await run(
    ScriptRunner,
    `
      const group = api.monsters().find((g) => g.id === -2)
      api.log('started', await api.attack(group, { approach: false }))
    `
  )

  assert.strictEqual(result.status, 'done', `the attack should finish, got ${result.error ?? ''}`)
  assert.strictEqual(state.attackButton.clicked > 0, true, 'the attack button is pressed')
  assert.ok(
    logs.some((line) => line.includes('attack button')),
    'the strategy used is written to the log'
  )
  assert.ok(
    !state.sent.some((message) => message.name === 'GameRolePlayAttackMonsterRequestMessage'),
    'the raw request is not sent when the button worked'
  )
  assert.ok(logs.some((line) => line.includes('started true')), 'the fight starts')
  console.log('ok - attack uses the game flow')
}

async function testAttackFallsBackToProtocol(ScriptRunner) {
  const { logs, state } = await run(
    ScriptRunner,
    `
      const group = api.monsters().find((g) => g.id === -2)
      api.log('started', await api.attack(group, { approach: false }))
    `,
    {},
    (state) => {
      state.attackButtonVisible = false
    }
  )

  assert.ok(
    state.sent.some((message) => message.name === 'GameRolePlayAttackMonsterRequestMessage'),
    'without a button, the network request is sent'
  )
  assert.ok(logs.some((line) => line.includes('started true')), 'the fight still starts')
  console.log('ok - attack falls back to the protocol')
}

async function testAttackKeepsProbingAndReports(ScriptRunner) {
  const { logs, state } = await run(
    ScriptRunner,
    `
      const group = api.monsters().find((g) => g.id === -2)
      api.log('started', await api.attack(group, { approach: false, timeout: 1500 }))
    `,
    {},
    (state) => {
      // A method that swallows anything without doing a thing, like a minified
      // client, and no button anywhere.
      state.attackButtonVisible = false
      state.noopAttackMethods = true
    }
  )

  assert.ok(
    logs.some((line) => line.includes('gui.openContextualMenu()')),
    'the no-op method is reported as tried'
  )
  assert.ok(
    logs.some((line) => /tried .*,/.test(line)),
    'the search continues past it instead of stopping at the first call'
  )
  assert.ok(
    logs.some((line) => line.includes('on screen now')),
    'what is on screen is reported when nothing works'
  )
  assert.ok(logs.some((line) => line.includes('started false')), 'the failure is honest')
  console.log('ok - attack keeps probing and reports')
}

async function testAttackApproach(ScriptRunner) {
  const { logs, state } = await run(
    ScriptRunner,
    `
      const far = api.monsters().find((group) => group.id === -1)
      api.log('target cell', far.cellId)
      api.log('started', await api.attack(far))
    `
  )

  // The far group sits on cell 300, out of reach: we must walk next to it,
  // never onto it — that cell is occupied and the walk would never complete.
  assert.strictEqual(state.moves.length, 1, 'one approach move is requested')
  const landing = state.moves[0]
  assert.notStrictEqual(landing, 300, 'the character does not walk onto the group')
  assert.ok(
    logs.some((line) => line.includes('next to the group on 300')),
    'the approach is reported in the log'
  )
  assert.ok(
    logs.some((line) => line.includes('Attack: requesting group -1')),
    'the attack request is reported with the group id'
  )
  assert.ok(logs.some((line) => line.includes('started true')), 'the fight starts')
  console.log('ok - attack approach')
}

async function testClosePopups(ScriptRunner) {
  const { result, logs, state } = await run(
    ScriptRunner,
    `api.log('closed', api.closePopups().join(','))`
  )

  assert.strictEqual(result.status, 'done')
  assert.ok(
    logs.some((line) => line.includes('closed fightEnd,levelUp')),
    'the fight results and level-up screens are closed'
  )
  assert.ok(
    !state.closedWindows.includes('inventory'),
    'unrelated windows are left alone'
  )
  console.log('ok - close end screens')
}

async function testTurnCombos() {
  await bundleModule(path.join(root, 'packages/renderer/src/mods/combat-ai.ts'))
  const { initCombatAi } = await import(`${pathToFileURL(combatBundlePath).href}?t=${Date.now()}`)

  const { gameWindow, state } = createFakeGameWindow()
  state.startFight()

  const logs = []
  const combatSettings = {
    enabled: true,
    combo: [{ id: 165, name: 'Attack' }],
    turnCombos: [{ turn: 1, combo: [{ id: 100, name: 'Buff' }, { id: 101, name: 'Boost' }] }],
    targetStrategy: 'first',
    autoReady: true,
    turnStartDelayMs: 0,
    castDelayMs: 0,
    readyDelayMs: 0,
    placeBeforeReady: false,
    randomJitterMs: 0,
    endTurnAfterCombo: true,
    closeEndScreens: true,
    approachEnemies: false,
    defaultSpellRange: 1,
    preferLineUp: false,
    positioning: 'close-in',
    positioning: 'close-in',
    tackleAware: true,
    spreadCasts: false,
    spellMode: 'combo',
    elements: ['fire', 'earth', 'water', 'air', 'neutral']
  }

  const dispose = initCombatAi(gameWindow, 'tab-1', {
    getSettings: () => combatSettings,
    onLog: (message) => logs.push(message)
  })

  const spellsCast = () =>
    state.sent
      .filter((message) => message.name === 'GameActionFightCastRequestMessage')
      .map((message) => message.data.spellId)

  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.deepStrictEqual(spellsCast(), [100, 101], 'turn 1 plays its own combo')
  assert.ok(logs.some((line) => line.includes('Turn 1: playing the turn 1 combo')), 'the combo used is logged')

  state.sent.length = 0
  state.startTurn(20)
  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.deepStrictEqual(spellsCast(), [165], 'turn 2 falls back to the default combo')

  // An empty override means "cast nothing and pass".
  state.sent.length = 0
  combatSettings.turnCombos = [{ turn: 3, combo: [] }]
  state.startTurn(20)
  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.deepStrictEqual(spellsCast(), [], 'an empty turn combo casts nothing')
  assert.ok(
    state.sent.some((message) => message.name === 'GameFightTurnFinishMessage'),
    'the turn is still passed'
  )

  // A new fight restarts the turn count.
  state.endFight()
  state.sent.length = 0
  state.startFight()
  state.emit('GameFightStartingMessage', {})
  combatSettings.turnCombos = [{ turn: 1, combo: [{ id: 100, name: 'Buff' }] }]
  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.deepStrictEqual(spellsCast(), [100], 'the turn counter resets between fights')

  dispose()
  console.log('ok - per-turn combos')
}

async function testApproachWithMp() {
  await bundleModule(path.join(root, 'packages/renderer/src/mods/combat-ai.ts'))
  const { initCombatAi } = await import(`${pathToFileURL(combatBundlePath).href}?t=${Date.now()}`)

  const { gameWindow, state } = createFakeGameWindow()
  state.startFight()

  const logs = []
  const combatSettings = {
    enabled: true,
    combo: [{ id: 165, name: 'Attack' }],
    turnCombos: [],
    targetStrategy: 'first',
    autoReady: true,
    turnStartDelayMs: 0,
    castDelayMs: 0,
    readyDelayMs: 0,
    placeBeforeReady: false,
    randomJitterMs: 0,
    endTurnAfterCombo: true,
    closeEndScreens: true,
    approachEnemies: true,
    defaultSpellRange: 1,
    preferLineUp: false,
    positioning: 'close-in',
    tackleAware: true,
    spreadCasts: false,
    spellMode: 'combo',
    elements: ['fire', 'earth', 'water', 'air', 'neutral']
  }

  const dispose = initCombatAi(gameWindow, 'tab-1', {
    getSettings: () => combatSettings,
    onLog: (message) => logs.push(message)
  })

  // Enemy on cell 294 is 1 cell away: already in range, no move expected.
  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.strictEqual(state.moves.length, 0, 'no move when the target is already in range')

  // Push the enemy out of range: the AI should walk with its 3 MP.
  state.fighters[1].data.disposition.cellId = 322
  state.sent.length = 0
  state.startTurn(20)
  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 400))

  assert.strictEqual(state.moves.length, 1, 'one move is requested')
  const destination = state.moves[0]
  assert.notStrictEqual(destination, 322, 'the AI does not walk onto the enemy cell')
  assert.ok(logs.some((line) => line.includes('Moving to cell')), 'the move is logged')
  assert.ok(
    state.sent.some((message) => message.name === 'GameActionFightCastRequestMessage'),
    'the spell is cast after moving'
  )

  // With no MP left it should say so instead of moving.
  // Put the character back where it started, far from the enemy.
  state.mpPerTurn = 0
  state.fighters[0].data.disposition.cellId = 280
  gameWindow.isoEngine.actorManager.userActor.cellId = 280
  state.fighters[1].data.disposition.cellId = 322
  state.moves.length = 0
  state.startTurn(20)
  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.strictEqual(state.moves.length, 0, 'no move without MP')
  assert.ok(logs.some((line) => line.includes('no MP left')), 'the missing MP is reported')

  dispose()
  console.log('ok - approach with MP')
}

async function testSelfCastAndLineUp() {
  await bundleModule(path.join(root, 'packages/renderer/src/mods/combat-ai.ts'))
  const { initCombatAi } = await import(`${pathToFileURL(combatBundlePath).href}?t=${Date.now()}`)
  await bundleModule(path.join(root, 'packages/renderer/src/scripts/fight-bridge.ts'))
  const { cellCoordinates, cellDistance, areCellsAligned } = await import(
    `${pathToFileURL(path.join(tmpDir, 'fight-bridge.js')).href}?t=${Date.now()}`
  )

  const { gameWindow, state } = createFakeGameWindow()
  state.startFight()

  const logs = []
  const combatSettings = {
    enabled: true,
    combo: [
      { id: 100, name: 'Buff', self: true },
      { id: 165, name: 'Attack' }
    ],
    turnCombos: [],
    targetStrategy: 'first',
    autoReady: true,
    turnStartDelayMs: 0,
    castDelayMs: 0,
    readyDelayMs: 0,
    placeBeforeReady: false,
    randomJitterMs: 0,
    endTurnAfterCombo: true,
    closeEndScreens: true,
    approachEnemies: true,
    defaultSpellRange: 1,
    preferLineUp: true,
    positioning: 'close-in',
    tackleAware: true,
    spreadCasts: false,
    spellMode: 'combo',
    elements: ['fire', 'earth', 'water', 'air', 'neutral']
  }

  const dispose = initCombatAi(gameWindow, 'tab-1', {
    getSettings: () => combatSettings,
    onLog: (message) => logs.push(message)
  })

  // Far enemy: the AI must spend its MP to close in, not stand still.
  const myCell = 280
  const farCell = 400
  state.fighters[0].data.disposition.cellId = myCell
  gameWindow.isoEngine.actorManager.userActor.cellId = myCell
  state.fighters[1].data.disposition.cellId = farCell
  state.fighters[2].data.disposition.cellId = farCell

  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 400))

  const casts = state.sent.filter((m) => m.name === 'GameActionFightCastRequestMessage')
  assert.strictEqual(casts[0].data.spellId, 100, 'the self spell is cast first')
  assert.strictEqual(
    casts[0].data.cellId,
    state.fighters[0].data.disposition.cellId,
    'the self spell targets our own cell, wherever the turn left us'
  )
  assert.ok(logs.some((line) => line.includes('on myself')), 'the self cast is logged')

  assert.strictEqual(state.moves.length, 1, 'the AI moves towards a far target')
  const destination = state.moves[0]
  const spent = cellDistance(myCell, destination)
  assert.strictEqual(spent, 3, 'it spends all 3 MP when the target is far')
  assert.ok(
    cellDistance(destination, farCell) < cellDistance(myCell, farCell),
    'the move closes distance to the target'
  )
  // Nothing lines up within 3 MP here, so closing distance is the right call.
  assert.ok(
    !areCellsAligned(myCell, farCell),
    'the starting position is not lined up with the target'
  )

  // Now a lined-up cell is reachable: it must win over one more cell of progress.
  const cellAt = (x, y) => {
    for (let cellId = 0; cellId < 560; cellId++) {
      const point = cellCoordinates(cellId)
      if (point.x === x && point.y === y) return cellId
    }
    throw new Error(`no cell at [${x}, ${y}]`)
  }

  const nearTarget = cellAt(12, 4)
  state.fighters[0].data.disposition.cellId = myCell
  gameWindow.isoEngine.actorManager.userActor.cellId = myCell
  state.fighters[1].data.disposition.cellId = nearTarget
  state.fighters[2].data.disposition.cellId = nearTarget
  state.moves.length = 0

  state.startTurn(20)
  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 400))

  assert.strictEqual(state.moves.length, 1, 'the AI moves again')
  const lined = state.moves[0]
  assert.ok(
    areCellsAligned(lined, nearTarget),
    `the destination lines up with the target (${JSON.stringify(cellCoordinates(lined))} vs [12, 4])`
  )
  assert.ok(
    cellDistance(lined, nearTarget) < cellDistance(myCell, nearTarget),
    'lining up still closes distance'
  )

  dispose()
  console.log('ok - self cast and line-up approach')
}

async function testRangeAndShortWalk() {
  await bundleModule(path.join(root, 'packages/renderer/src/mods/combat-ai.ts'))
  const { initCombatAi } = await import(`${pathToFileURL(combatBundlePath).href}?t=${Date.now()}`)
  await bundleModule(path.join(root, 'packages/renderer/src/scripts/fight-bridge.ts'))
  const { cellDistance } = await import(
    `${pathToFileURL(path.join(tmpDir, 'fight-bridge.js')).href}?t=${Date.now()}`
  )

  const { gameWindow, state } = createFakeGameWindow()
  state.startFight()

  const logs = []
  const combatSettings = {
    enabled: true,
    // The spell reaches 6 cells, so no walking should happen at 4.
    combo: [{ id: 165, name: 'Bolt', range: 6 }],
    turnCombos: [],
    targetStrategy: 'first',
    autoReady: true,
    turnStartDelayMs: 0,
    castDelayMs: 0,
    readyDelayMs: 0,
    placeBeforeReady: false,
    randomJitterMs: 0,
    endTurnAfterCombo: true,
    closeEndScreens: true,
    approachEnemies: true,
    defaultSpellRange: 1,
    preferLineUp: false,
    positioning: 'close-in',
    tackleAware: true,
    spreadCasts: false,
    spellMode: 'combo',
    elements: ['fire', 'earth', 'water', 'air', 'neutral']
  }

  const dispose = initCombatAi(gameWindow, 'tab-1', {
    getSettings: () => combatSettings,
    onLog: (message) => logs.push(message)
  })

  // Enemy 4 cells away: within the spell's own range, so cast without moving.
  const myCell = 280
  const enemyCell = 336
  state.fighters[0].data.disposition.cellId = myCell
  gameWindow.isoEngine.actorManager.userActor.cellId = myCell
  state.fighters[1].data.disposition.cellId = enemyCell
  state.fighters[2].data.disposition.cellId = enemyCell
  assert.strictEqual(cellDistance(myCell, enemyCell), 4, 'the enemy is 4 cells away')

  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 300))

  assert.strictEqual(state.moves.length, 0, 'a ranged spell does not chase the target')
  assert.ok(
    state.sent.some((message) => message.name === 'GameActionFightCastRequestMessage'),
    'the spell is cast from where we stand'
  )
  assert.ok(logs.some((line) => line.includes('from 4 cell(s)')), 'the cast distance is logged')

  // Now a melee spell against a walk the engine cuts short.
  combatSettings.combo = [{ id: 165, name: 'Punch', range: 1 }]
  state.fighters[0].data.disposition.cellId = myCell
  gameWindow.isoEngine.actorManager.userActor.cellId = myCell
  state.moves.length = 0
  state.sent.length = 0
  // The engine only ever advances one cell towards the request.
  state.walkLimit = () => 294

  state.emit('GameFightTurnEndMessage', { id: 7 })
  state.startTurn(20)
  state.emit('GameFightTurnEndMessage', { id: 20 })
  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 1500))

  assert.strictEqual(state.moves.length, 1, 'one move per turn, never a burst of small steps')
  assert.ok(
    logs.some((line) => line.includes('Stopped on cell 294')),
    'a walk cut short by an obstacle is reported'
  )
  assert.ok(
    state.sent.some((message) => message.name === 'GameActionFightCastRequestMessage'),
    'the spell is still cast afterwards'
  )

  state.walkLimit = null
  dispose()
  console.log('ok - spell range and short walks')
}

async function testKitingAndSingleMove() {
  await bundleModule(path.join(root, 'packages/renderer/src/mods/combat-ai.ts'))
  const { initCombatAi } = await import(`${pathToFileURL(combatBundlePath).href}?t=${Date.now()}`)
  await bundleModule(path.join(root, 'packages/renderer/src/scripts/fight-bridge.ts'))
  const { cellDistance } = await import(
    `${pathToFileURL(path.join(tmpDir, 'fight-bridge.js')).href}?t=${Date.now()}`
  )

  const { gameWindow, state } = createFakeGameWindow()
  state.startFight()

  const logs = []
  const combatSettings = {
    enabled: true,
    combo: [{ id: 165, name: 'Bolt', range: 5 }],
    turnCombos: [],
    targetStrategy: 'first',
    autoReady: true,
    turnStartDelayMs: 0,
    castDelayMs: 0,
    readyDelayMs: 0,
    placeBeforeReady: false,
    randomJitterMs: 0,
    endTurnAfterCombo: true,
    closeEndScreens: true,
    approachEnemies: true,
    defaultSpellRange: 1,
    preferLineUp: false,
    positioning: 'keep-distance',
    tackleAware: true,
    spreadCasts: false,
    spellMode: 'combo',
    elements: ['fire', 'earth', 'water', 'air', 'neutral']
  }

  const dispose = initCombatAi(gameWindow, 'tab-1', {
    getSettings: () => combatSettings,
    onLog: (message) => logs.push(message)
  })

  // An enemy three cells away, with a spell that reaches five: the kiting AI
  // should back off — while staying able to cast — rather than stand still.
  const myCell = 280
  const enemyCell = 322
  state.fighters[0].data.disposition.cellId = myCell
  gameWindow.isoEngine.actorManager.userActor.cellId = myCell
  state.fighters[1].data.disposition.cellId = enemyCell
  state.fighters[2].data.disposition.cellId = enemyCell
  const startDistance = cellDistance(myCell, enemyCell)
  assert.ok(startDistance > 1 && startDistance < 5, 'the enemy starts in range but not in contact')

  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 500))

  assert.strictEqual(state.moves.length, 1, 'exactly one move is requested for the turn')
  const landing = state.moves[0]
  assert.ok(
    cellDistance(landing, enemyCell) > startDistance,
    'the AI backs away from the enemy'
  )
  assert.ok(cellDistance(landing, enemyCell) <= 5, 'it stays within casting range')
  assert.ok(logs.some((line) => line.includes('keeping')), 'the intent is logged')
  assert.ok(
    state.sent.some((message) => message.name === 'GameActionFightCastRequestMessage'),
    'the spell is cast from the new position'
  )

  // Closing in is still available for melee builds.
  state.sent.length = 0
  state.moves.length = 0
  combatSettings.positioning = 'close-in'
  combatSettings.combo = [{ id: 165, name: 'Punch', range: 1 }]
  state.fighters[0].data.disposition.cellId = myCell
  gameWindow.isoEngine.actorManager.userActor.cellId = myCell
  state.fighters[1].data.disposition.cellId = 350
  state.fighters[2].data.disposition.cellId = 350

  state.emit('GameFightTurnEndMessage', { id: 7 })
  state.startTurn(20)
  state.emit('GameFightTurnEndMessage', { id: 20 })
  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 500))

  assert.strictEqual(state.moves.length, 1, 'still a single move per turn')
  assert.ok(
    cellDistance(state.moves[0], 350) < cellDistance(myCell, 350),
    'close-in walks towards the target'
  )

  dispose()
  console.log('ok - kiting and one move per turn')
}

async function testSpreadCasts() {
  await bundleModule(path.join(root, 'packages/renderer/src/mods/combat-ai.ts'))
  const { initCombatAi } = await import(`${pathToFileURL(combatBundlePath).href}?t=${Date.now()}`)

  const { gameWindow, state } = createFakeGameWindow()
  state.startFight()

  const combatSettings = {
    enabled: true,
    combo: [
      { id: 100, name: 'First', range: 12 },
      { id: 101, name: 'Second', range: 12 }
    ],
    turnCombos: [],
    targetStrategy: 'nearest',
    autoReady: true,
    turnStartDelayMs: 0,
    castDelayMs: 0,
    readyDelayMs: 0,
    placeBeforeReady: false,
    randomJitterMs: 0,
    endTurnAfterCombo: true,
    closeEndScreens: true,
    approachEnemies: false,
    defaultSpellRange: 12,
    preferLineUp: false,
    positioning: 'keep-distance',
    tackleAware: true,
    spreadCasts: true
  }

  const dispose = initCombatAi(gameWindow, 'tab-1', {
    getSettings: () => combatSettings,
    onLog: () => {}
  })

  const casts = () =>
    state.sent
      .filter((message) => message.name === 'GameActionFightCastRequestMessage')
      .map((message) => `${message.data.spellId}@${message.data.cellId}`)

  // Two enemies in range: the same spell goes once on each.
  state.fighters[0].data.disposition.cellId = 280
  gameWindow.isoEngine.actorManager.userActor.cellId = 280
  state.fighters[1].data.disposition.cellId = 294
  state.fighters[2].data.disposition.cellId = 350

  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 500))

  assert.deepStrictEqual(
    casts(),
    ['100@294', '100@350', '101@294', '101@350'],
    'each spell is cast once per enemy in range'
  )

  // A single enemy in range: the combo plays out on it, spell after spell.
  state.sent.length = 0
  state.fighters[2].data.alive = false

  state.emit('GameFightTurnEndMessage', { id: 7 })
  state.startTurn(20)
  state.emit('GameFightTurnEndMessage', { id: 20 })
  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 500))

  assert.deepStrictEqual(
    casts(),
    ['100@294', '101@294'],
    'with one enemy left the combo runs as written'
  )

  state.fighters[2].data.alive = true
  dispose()
  console.log('ok - casts spread over the enemies in range')
}

async function testTackleAwareness() {
  await bundleModule(path.join(root, 'packages/renderer/src/mods/combat-ai.ts'))
  const { initCombatAi } = await import(`${pathToFileURL(combatBundlePath).href}?t=${Date.now()}`)
  await bundleModule(path.join(root, 'packages/renderer/src/scripts/fight-bridge.ts'))
  const { cellDistance } = await import(
    `${pathToFileURL(path.join(tmpDir, 'fight-bridge.js')).href}?t=${Date.now()}`
  )

  const { gameWindow, state } = createFakeGameWindow()
  state.startFight()

  const logs = []
  const combatSettings = {
    enabled: true,
    combo: [{ id: 165, name: 'Bolt', range: 5 }],
    turnCombos: [],
    targetStrategy: 'first',
    autoReady: true,
    turnStartDelayMs: 0,
    castDelayMs: 0,
    readyDelayMs: 0,
    placeBeforeReady: false,
    randomJitterMs: 0,
    endTurnAfterCombo: true,
    closeEndScreens: true,
    approachEnemies: true,
    defaultSpellRange: 1,
    preferLineUp: false,
    positioning: 'keep-distance',
    tackleAware: true,
    spreadCasts: false,
    spellMode: 'combo',
    elements: ['fire', 'earth', 'water', 'air', 'neutral']
  }

  const dispose = initCombatAi(gameWindow, 'tab-1', {
    getSettings: () => combatSettings,
    onLog: (message) => logs.push(message)
  })

  const myCell = 280
  const meleeCell = 294

  // 1. One MP against a monster in contact: no escape can clear melee, so the
  // turn is spent casting instead of paying the tackle for nothing.
  state.mpPerTurn = 1
  state.fighters[0].data.disposition.cellId = myCell
  gameWindow.isoEngine.actorManager.userActor.cellId = myCell
  state.fighters[1].data.disposition.cellId = meleeCell
  state.fighters[2].data.disposition.cellId = meleeCell

  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 500))

  assert.strictEqual(state.moves.length, 0, 'no move at all while held in contact')
  assert.ok(
    logs.some((line) => line.includes('not moving, casting from here')),
    'the reason is logged'
  )
  assert.ok(
    state.sent.some((message) => message.name === 'GameActionFightCastRequestMessage'),
    'the spell is cast from where we stand'
  )

  // 2. Even with plenty of MP, a monster in contact means no move at all.
  state.mpPerTurn = 4
  state.moves.length = 0
  state.sent.length = 0
  state.fighters[0].data.disposition.cellId = myCell
  gameWindow.isoEngine.actorManager.userActor.cellId = myCell

  state.emit('GameFightTurnEndMessage', { id: 7 })
  state.startTurn(20)
  state.emit('GameFightTurnEndMessage', { id: 20 })
  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 600))

  assert.strictEqual(state.moves.length, 0, 'never break away from a monster in contact')
  assert.ok(
    logs.some((line) => line.includes('not moving, casting from here')),
    'staying put is announced'
  )
  assert.ok(
    state.sent.some((message) => message.name === 'GameActionFightCastRequestMessage'),
    'the turn is spent casting'
  )

  // 3. Out of contact, the AI positions itself as usual.
  state.moves.length = 0
  state.sent.length = 0
  state.fighters[1].data.disposition.cellId = 400
  state.fighters[2].data.disposition.cellId = 400
  state.fighters[0].data.disposition.cellId = myCell
  gameWindow.isoEngine.actorManager.userActor.cellId = myCell

  state.emit('GameFightTurnEndMessage', { id: 7 })
  state.startTurn(20)
  state.emit('GameFightTurnEndMessage', { id: 20 })
  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 600))

  assert.strictEqual(state.moves.length, 1, 'with no one in contact it still moves')

  dispose()
  console.log('ok - tackle awareness')
}

async function testFightMovementGoesThroughTheServer() {
  await bundleModule(path.join(root, 'packages/renderer/src/mods/combat-ai.ts'))
  const { initCombatAi } = await import(`${pathToFileURL(combatBundlePath).href}?t=${Date.now()}`)
  await bundleModule(path.join(root, 'packages/renderer/src/scripts/cells.ts'))
  const { cellCoordinates, neighbourCells, cellFromCoordinates } = await import(
    `${pathToFileURL(path.join(tmpDir, 'cells.js')).href}?t=${Date.now()}`
  )

  // The grid maths the path is built on.
  for (let cellId = 0; cellId < 560; cellId++) {
    const point = cellCoordinates(cellId)
    assert.strictEqual(cellFromCoordinates(point.x, point.y), cellId, 'coordinates round-trip')
  }
  assert.ok(neighbourCells(280).every((cell) => neighbourCells(cell).includes(280)), 'steps are symmetric')

  const { gameWindow, state } = createFakeGameWindow()
  state.startFight()

  const logs = []
  const combatSettings = {
    enabled: true,
    combo: [{ id: 165, name: 'Punch', range: 1 }],
    turnCombos: [],
    targetStrategy: 'first',
    autoReady: true,
    turnStartDelayMs: 0,
    castDelayMs: 0,
    readyDelayMs: 0,
    placeBeforeReady: false,
    randomJitterMs: 0,
    endTurnAfterCombo: true,
    closeEndScreens: true,
    approachEnemies: true,
    defaultSpellRange: 1,
    preferLineUp: false,
    positioning: 'close-in',
    tackleAware: true,
    spreadCasts: false,
    spellMode: 'combo',
    elements: ['fire', 'earth', 'water', 'air', 'neutral']
  }

  const dispose = initCombatAi(gameWindow, 'tab-1', {
    getSettings: () => combatSettings,
    onLog: (message) => logs.push(message)
  })

  state.fighters[0].data.disposition.cellId = 280
  gameWindow.isoEngine.actorManager.userActor.cellId = 280
  state.fighters[1].data.disposition.cellId = 336
  state.fighters[2].data.disposition.cellId = 336

  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 700))

  const moveMessages = state.sent.filter((m) => m.name === 'GameMapMovementRequestMessage')
  assert.strictEqual(moveMessages.length, 1, 'the move is sent to the server')

  const keys = moveMessages[0].data.keyMovements
  assert.ok(Array.isArray(keys) && keys.length >= 2, 'the path carries at least a start and an end')
  assert.strictEqual(keys[0] & 0xfff, 280, 'it starts where the character stands')
  assert.ok(
    keys.every((key) => [0, 2, 4, 6].includes(key >> 12)),
    'every step is one of the four fight directions'
  )
  const walked = keys.map((key) => key & 0xfff)
  for (let index = 1; index < walked.length; index++) {
    assert.ok(
      neighbourCells(walked[index - 1]).includes(walked[index]),
      `step ${index} goes to a neighbouring cell`
    )
  }

  // A refused move must be reported, not taken for granted.
  state.sent.length = 0
  state.serverRefusesMoves = true
  state.fighters[0].data.disposition.cellId = 280
  gameWindow.isoEngine.actorManager.userActor.cellId = 280

  state.emit('GameFightTurnEndMessage', { id: 7 })
  state.startTurn(20)
  state.emit('GameFightTurnEndMessage', { id: 20 })
  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 1500))

  assert.ok(
    logs.some((line) => line.includes('server refused the move')),
    'a rollback is called out'
  )
  assert.ok(
    state.sent.some((m) => m.name === 'GameFightTurnFinishMessage'),
    'the turn is still passed'
  )

  state.serverRefusesMoves = false
  dispose()
  console.log('ok - fight movement reaches the server')
}

async function testHumanDelays() {
  await bundleModule(path.join(root, 'packages/renderer/src/mods/combat-ai.ts'))
  const { initCombatAi } = await import(`${pathToFileURL(combatBundlePath).href}?t=${Date.now()}`)

  const { gameWindow, state } = createFakeGameWindow()

  const combatSettings = {
    enabled: true,
    combo: [{ id: 165, name: 'Bolt', range: 5 }],
    turnCombos: [],
    targetStrategy: 'first',
    autoReady: true,
    turnStartDelayMs: 0,
    castDelayMs: 0,
    readyDelayMs: 300,
    randomJitterMs: 200,
    endTurnAfterCombo: true,
    closeEndScreens: true,
    approachEnemies: false,
    defaultSpellRange: 1,
    preferLineUp: false,
    positioning: 'keep-distance',
    tackleAware: true,
    spreadCasts: false,
    spellMode: 'combo',
    elements: ['fire', 'earth', 'water', 'air', 'neutral']
  }

  const dispose = initCombatAi(gameWindow, 'tab-1', {
    getSettings: () => combatSettings,
    onLog: () => {}
  })

  const readySent = () => state.sent.some((message) => message.name === 'GameFightReadyMessage')

  state.startFight()
  state.emit('GameFightStartingMessage', {})

  assert.strictEqual(readySent(), false, 'ready is not pressed on the same tick')
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.strictEqual(readySent(), false, 'nor before the configured delay')

  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.strictEqual(readySent(), true, 'but it is pressed once the pause is over')

  // Two turns in a row must not be spaced identically.
  combatSettings.readyDelayMs = 0
  combatSettings.turnStartDelayMs = 40
  combatSettings.randomJitterMs = 400

  const gaps = []
  for (let round = 0; round < 3; round++) {
    state.sent.length = 0
    state.emit('GameFightTurnEndMessage', { id: 7 })
    state.startTurn(20)
    state.emit('GameFightTurnEndMessage', { id: 20 })
    const startedAt = Date.now()
    state.startTurn(7)
    await new Promise((resolve) => setTimeout(resolve, 900))
    const cast = state.sent.find((message) => message.name === 'GameActionFightCastRequestMessage')
    assert.ok(cast, 'the spell is cast every turn')
    gaps.push(Date.now() - startedAt)
  }

  assert.ok(
    gaps.every((gap) => gap >= 40),
    `every turn waits at least the configured pause (${gaps.join(', ')})`
  )

  dispose()
  console.log('ok - randomised pauses')
}

async function testTurnAlwaysPassed() {
  await bundleModule(path.join(root, 'packages/renderer/src/mods/combat-ai.ts'))
  const { initCombatAi } = await import(`${pathToFileURL(combatBundlePath).href}?t=${Date.now()}`)

  const { gameWindow, state } = createFakeGameWindow()
  state.startFight()

  const logs = []
  const combatSettings = {
    enabled: true,
    combo: [{ id: 165, name: 'Bolt', range: 5 }],
    turnCombos: [],
    targetStrategy: 'first',
    autoReady: true,
    turnStartDelayMs: 0,
    castDelayMs: 0,
    readyDelayMs: 0,
    placeBeforeReady: false,
    randomJitterMs: 0,
    endTurnAfterCombo: true,
    closeEndScreens: true,
    approachEnemies: true,
    defaultSpellRange: 1,
    preferLineUp: true,
    positioning: 'keep-distance',
    tackleAware: true,
    spreadCasts: false,
    spellMode: 'combo',
    elements: ['fire', 'earth', 'water', 'air', 'neutral']
  }

  const dispose = initCombatAi(gameWindow, 'tab-1', {
    getSettings: () => combatSettings,
    onLog: (message) => logs.push(message)
  })

  state.fighters[0].data.disposition.cellId = 280
  gameWindow.isoEngine.actorManager.userActor.cellId = 280
  state.fighters[1].data.disposition.cellId = 322
  state.fighters[2].data.disposition.cellId = 322

  // The two emitters each deliver the previous fighter's turn end, and it can
  // land after our turn started. That must not abort our turn.
  state.startTurn(7)
  state.emit('GameFightTurnEndMessage', { id: 20 })
  await new Promise((resolve) => setTimeout(resolve, 700))

  assert.ok(
    state.sent.some((message) => message.name === 'GameActionFightCastRequestMessage'),
    'a stale turn end from another fighter does not cancel our turn'
  )
  assert.ok(
    state.sent.some((message) => message.name === 'GameFightTurnFinishMessage'),
    'the turn is passed'
  )

  // Even when the combo cannot be played, the turn is never left hanging.
  state.sent.length = 0
  combatSettings.combo = []
  state.emit('GameFightTurnEndMessage', { id: 7 })
  state.startTurn(20)
  state.emit('GameFightTurnEndMessage', { id: 20 })
  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 500))

  assert.ok(
    state.sent.some((message) => message.name === 'GameFightTurnFinishMessage'),
    'an empty combo still passes the turn'
  )

  dispose()
  console.log('ok - the turn is always passed')
}

async function testTurnSynchronisation() {
  await bundleModule(path.join(root, 'packages/renderer/src/mods/combat-ai.ts'))
  const { initCombatAi } = await import(`${pathToFileURL(combatBundlePath).href}?t=${Date.now()}`)

  const { gameWindow, state } = createFakeGameWindow()
  state.startFight()

  const logs = []
  const combatSettings = {
    enabled: true,
    combo: [{ id: 165, name: 'Attack' }],
    turnCombos: [],
    targetStrategy: 'first',
    autoReady: true,
    turnStartDelayMs: 0,
    castDelayMs: 0,
    readyDelayMs: 0,
    placeBeforeReady: false,
    randomJitterMs: 0,
    endTurnAfterCombo: true,
    closeEndScreens: true,
    approachEnemies: false,
    defaultSpellRange: 1,
    preferLineUp: false,
    positioning: 'close-in',
    positioning: 'close-in',
    tackleAware: true,
    spreadCasts: false,
    spellMode: 'combo',
    elements: ['fire', 'earth', 'water', 'air', 'neutral']
  }

  const dispose = initCombatAi(gameWindow, 'tab-1', {
    getSettings: () => combatSettings,
    onLog: (message) => logs.push(message)
  })

  const names = () => state.sent.map((message) => message.name)

  // 1. Nothing is sent until the server says the turn can be played.
  state.startTurnPending(7)
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.deepStrictEqual(names(), [], 'no input before the turn is playable')

  state.setPlayable(7)
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.ok(names().includes('GameActionFightCastRequestMessage'), 'the spell is cast once playable')
  assert.ok(names().includes('GameFightTurnFinishMessage'), 'the turn is then passed')

  // 2. The turn is not ended while an animation sequence is running.
  state.sent.length = 0
  state.emit('GameFightTurnEndMessage', { id: 7 })
  state.startTurn(20)
  state.emit('GameFightTurnEndMessage', { id: 20 })
  state.emit('SequenceStartMessage', {})
  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 300))

  assert.ok(
    !names().includes('GameFightTurnFinishMessage'),
    'the turn stays open while a sequence is in flight'
  )

  state.emit('SequenceEndMessage', {})
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.ok(names().includes('GameFightTurnFinishMessage'), 'it is passed once the sequence ends')

  // 3. Nothing from a finished turn is sent late.
  state.sent.length = 0
  state.emit('GameFightTurnEndMessage', { id: 7 })
  state.emit('SequenceStartMessage', {})
  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 150))
  state.emit('GameFightTurnEndMessage', { id: 7 })
  state.startTurn(20)
  state.emit('SequenceEndMessage', {})
  await new Promise((resolve) => setTimeout(resolve, 300))

  assert.ok(
    !names().includes('GameFightTurnFinishMessage'),
    'no stale end-of-turn once the turn moved on'
  )

  // 4. A turn still waiting on the previous sequence must not swallow the next
  // one: this is what froze fights from turn 2 on.
  state.sent.length = 0
  state.emit('SequenceStartMessage', {})
  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.deepStrictEqual(names(), [], 'the stuck turn sends nothing')

  state.emit('GameFightTurnEndMessage', { id: 7 })
  state.startTurn(20)
  state.emit('GameFightTurnEndMessage', { id: 20 })
  state.startTurn(7)
  state.emit('SequenceEndMessage', {})
  await new Promise((resolve) => setTimeout(resolve, 400))

  assert.ok(names().includes('GameActionFightCastRequestMessage'), 'the next turn is played')
  assert.strictEqual(
    names().filter((name) => name === 'GameFightTurnFinishMessage').length,
    1,
    'exactly one end-of-turn is sent'
  )

  dispose()
  console.log('ok - turn synchronisation')
}

async function testMovementDiscovery(ScriptRunner) {
  const { result, logs, state } = await run(
    ScriptRunner,
    `
      api.log('cell before', api.cellId())
      await api.moveToCell(114)
      api.log('cell after', api.cellId())
    `
  )

  assert.strictEqual(result.status, 'done', `the walk should succeed, got ${result.error ?? ''}`)
  assert.deepStrictEqual(state.moves, [114], 'the working entry point is used')
  assert.ok(logs.some((line) => line.includes('cell after 114')), 'the character arrives')
  console.log('ok - movement entry point discovery')
}

async function testMovementReportsNoEntryPoint(ScriptRunner) {
  const { result } = await run(
    ScriptRunner,
    `await api.moveToCell(114)`,
    {},
    (state) => {
      state.disableMovement = true
    }
  )

  assert.strictEqual(result.status, 'error', 'a build without movement fails loudly')
  assert.match(
    result.error ?? '',
    /api\.inspect/,
    'the error points at the diagnostic'
  )
  console.log('ok - movement reports a missing entry point')
}

async function testModelBrain() {
  await bundleModule(path.join(root, 'packages/renderer/src/mods/combat-ai.ts'))
  const { initCombatAi } = await import(`${pathToFileURL(combatBundlePath).href}?t=${Date.now()}`)

  const { gameWindow, state } = createFakeGameWindow()
  state.startFight()

  const asked = []
  globalThis.window = {
    dofemu: {
      ollamaChat: async (request) => {
        asked.push(request)
        if (state.modelAnswer === null) return { ok: false, error: 'connection refused', elapsedMs: 12 }
        return { ok: true, content: state.modelAnswer, elapsedMs: 42 }
      }
    }
  }

  const logs = []
  const combatSettings = {
    enabled: true,
    combo: [{ id: 161, name: 'Bolt', range: 12 }],
    turnCombos: [],
    targetStrategy: 'nearest',
    autoReady: true,
    turnStartDelayMs: 0,
    castDelayMs: 0,
    readyDelayMs: 0,
    placeBeforeReady: false,
    randomJitterMs: 0,
    endTurnAfterCombo: true,
    closeEndScreens: true,
    approachEnemies: true,
    defaultSpellRange: 12,
    preferLineUp: false,
    positioning: 'keep-distance',
    tackleAware: true,
    spreadCasts: false,
    spellMode: 'combo',
    elements: ['fire', 'earth', 'water', 'air', 'neutral'],
    brain: 'ollama',
    ollamaEndpoint: 'http://127.0.0.1:11434',
    ollamaModel: 'test-model',
    ollamaTimeoutMs: 1000,
    preferChallenges: true
  }

  const dispose = initCombatAi(gameWindow, 'tab-1', {
    getSettings: () => combatSettings,
    onLog: (message) => logs.push(message)
  })

  state.fighters[0].data.disposition.cellId = 280
  gameWindow.isoEngine.actorManager.userActor.cellId = 280
  state.fighters[1].data.disposition.cellId = 350
  state.fighters[2].data.disposition.cellId = 350

  // The model answers with a legal cast plus one action it invented.
  state.modelAnswer = JSON.stringify({
    actions: [
      { type: 'cast', spellId: 161, targetId: 20 },
      { type: 'cast', spellId: 777, targetId: 20 }
    ],
    reason: 'hit the closest'
  })

  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 600))

  assert.strictEqual(asked.length, 1, 'the model is asked once for the turn')
  assert.strictEqual(asked[0].model, 'test-model', 'with the configured model')
  assert.ok(asked[0].prompt.includes('"cells"') || asked[0].prompt.includes('cells'), 'the prompt carries the state')

  const casts = state.sent.filter((m) => m.name === 'GameActionFightCastRequestMessage')
  assert.strictEqual(casts.length, 1, 'only the legal cast is played')
  assert.strictEqual(casts[0].data.spellId, 161)
  assert.ok(logs.some((line) => line.includes('hit the closest')), 'the reason is logged')
  assert.ok(logs.some((line) => line.includes('not in the combo')), 'the invented spell is reported')
  assert.ok(
    state.sent.some((m) => m.name === 'GameFightTurnFinishMessage'),
    'the turn is still passed'
  )

  // A plan that only walks must not end the turn without attacking.
  state.sent.length = 0
  logs.length = 0
  state.modelAnswer = JSON.stringify({
    actions: [{ type: 'move', cellId: 294 }],
    reason: 'reposition'
  })

  state.emit('GameFightTurnEndMessage', { id: 7 })
  state.startTurn(20)
  state.emit('GameFightTurnEndMessage', { id: 20 })
  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 900))

  assert.ok(
    logs.some((line) => line.includes('only moved')),
    'the shortfall is called out'
  )
  assert.ok(
    state.sent.some((m) => m.name === 'GameActionFightCastRequestMessage'),
    'the combo is cast on top of the model plan'
  )

  // With no model answering, the rules take the turn.
  state.sent.length = 0
  state.modelAnswer = null

  state.emit('GameFightTurnEndMessage', { id: 7 })
  state.startTurn(20)
  state.emit('GameFightTurnEndMessage', { id: 20 })
  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 800))

  assert.ok(
    logs.some((line) => line.includes('playing the rules')),
    'the fallback is announced'
  )
  assert.ok(
    state.sent.some((m) => m.name === 'GameActionFightCastRequestMessage'),
    'the rules still cast'
  )

  delete globalThis.window
  dispose()
  console.log('ok - model brain with fallback')
}

async function testPlacementAndLineOfSight() {
  await bundleModule(path.join(root, 'packages/renderer/src/mods/combat-ai.ts'))
  const { initCombatAi } = await import(`${pathToFileURL(combatBundlePath).href}?t=${Date.now()}`)
  await bundleModule(path.join(root, 'packages/renderer/src/scripts/fight-bridge.ts'))
  const { choosePlacementCell, findPositionCell, areCellsAligned } = await import(
    `${pathToFileURL(path.join(tmpDir, 'fight-bridge.js')).href}?t=${Date.now()}`
  )

  const { gameWindow, state } = createFakeGameWindow()
  state.startFight()

  state.fighters[0].data.disposition.cellId = 280
  gameWindow.isoEngine.actorManager.userActor.cellId = 280
  state.fighters[1].data.disposition.cellId = 336
  state.fighters[2].data.disposition.cellId = 336

  // A cell lined up with the enemy beats a merely safe one.
  const aligned = 322
  const offLine = 267
  assert.ok(areCellsAligned(aligned, 336), 'the first candidate is on the enemy line')
  const choice = choosePlacementCell(gameWindow, [offLine, aligned], { positioning: 'keep-distance' })
  assert.strictEqual(choice.cellId, aligned, 'the lined-up starting cell wins')

  // A blocked line must not count as aligned, or the AI stands behind a wall.
  gameWindow.isoEngine.mapRenderer.isInLineOfSight = (from, to) =>
    !(from === aligned && to === 336)
  const blocked = choosePlacementCell(gameWindow, [offLine, aligned], { positioning: 'keep-distance' })
  assert.strictEqual(blocked.cellId, offLine, 'a blocked line is worth nothing')

  const move = findPositionCell(
    gameWindow,
    { id: 20, teamId: 1, alive: true, cellId: 336, life: 100, maxLife: 100, ap: 6, mp: 3, name: 'Champ' },
    6,
    3,
    { preferLineUp: true, positioning: 'keep-distance', tackleAware: true }
  )
  if (move) {
    assert.notStrictEqual(move.cellId, aligned, 'and is never chosen to stand on')
    assert.strictEqual(
      move.aligned,
      gameWindow.isoEngine.mapRenderer.isInLineOfSight(move.cellId, 336) && areCellsAligned(move.cellId, 336),
      'alignment always implies a clear line'
    )
  }
  delete gameWindow.isoEngine.mapRenderer.isInLineOfSight

  // The placement step runs before ready, and only once.
  const logs = []
  const combatSettings = {
    enabled: true,
    combo: [{ id: 165, name: 'Bolt', range: 6 }],
    turnCombos: [],
    targetStrategy: 'nearest',
    autoReady: true,
    placeBeforeReady: true,
    turnStartDelayMs: 0,
    castDelayMs: 0,
    readyDelayMs: 40,
    randomJitterMs: 0,
    endTurnAfterCombo: true,
    closeEndScreens: true,
    approachEnemies: true,
    defaultSpellRange: 6,
    preferLineUp: true,
    positioning: 'keep-distance',
    tackleAware: true,
    spreadCasts: false,
    spellMode: 'combo',
    elements: ['fire', 'earth', 'water', 'air', 'neutral'],
    brain: 'rules',
    ollamaEndpoint: '',
    ollamaModel: '',
    ollamaTimeoutMs: 500,
    preferChallenges: false
  }

  const dispose = initCombatAi(gameWindow, 'tab-1', {
    getSettings: () => combatSettings,
    onLog: (message) => logs.push(message)
  })

  state.emit('GameFightPlacementPossiblePositionsMessage', { positions: [offLine, aligned] })
  state.emit('GameFightStartingMessage', {})
  await new Promise((resolve) => setTimeout(resolve, 400))

  const placements = state.sent.filter((m) => m.name === 'GameFightPlacementPositionRequestMessage')
  assert.strictEqual(placements.length, 1, 'one placement is requested')
  assert.strictEqual(placements[0].data.cellId, aligned, 'on the cell lined up with the enemy')
  assert.ok(logs.some((line) => line.includes('Taking starting cell')), 'the choice is logged')

  const readyAfter = state.sent.findIndex((m) => m.name === 'GameFightReadyMessage')
  const placedAt = state.sent.findIndex((m) => m.name === 'GameFightPlacementPositionRequestMessage')
  assert.ok(placedAt < readyAfter, 'the place is taken before readying')

  dispose()
  console.log('ok - placement and blocked lines')
}

async function testPushBreaksMelee() {
  await bundleModule(path.join(root, 'packages/renderer/src/mods/combat-ai.ts'))
  const { initCombatAi } = await import(`${pathToFileURL(combatBundlePath).href}?t=${Date.now()}`)
  await bundleModule(path.join(root, 'packages/renderer/src/scripts/fight-state.ts'))
  const { buildFightState } = await import(
    `${pathToFileURL(path.join(tmpDir, 'fight-state.js')).href}?t=${Date.now()}`
  )

  const { gameWindow, state } = createFakeGameWindow()
  state.startFight()

  const logs = []
  const combatSettings = {
    enabled: true,
    combo: [
      { id: 300, name: 'Shove', range: 4, push: true },
      { id: 165, name: 'Bolt', range: 6 }
    ],
    turnCombos: [],
    targetStrategy: 'nearest',
    autoReady: true,
    turnStartDelayMs: 0,
    castDelayMs: 0,
    readyDelayMs: 0,
    placeBeforeReady: false,
    randomJitterMs: 0,
    endTurnAfterCombo: true,
    closeEndScreens: true,
    approachEnemies: true,
    defaultSpellRange: 1,
    preferLineUp: false,
    positioning: 'keep-distance',
    tackleAware: true,
    spreadCasts: false,
    spellMode: 'combo',
    elements: ['fire', 'earth', 'water', 'air', 'neutral'],
    brain: 'rules',
    ollamaEndpoint: '',
    ollamaModel: '',
    ollamaTimeoutMs: 1000,
    preferChallenges: false
  }

  const dispose = initCombatAi(gameWindow, 'tab-1', {
    getSettings: () => combatSettings,
    onLog: (message) => logs.push(message)
  })

  // One monster in contact, one far away.
  state.fighters[0].data.disposition.cellId = 280
  gameWindow.isoEngine.actorManager.userActor.cellId = 280
  state.fighters[1].data.disposition.cellId = 294
  state.fighters[2].data.disposition.cellId = 400

  // The state handed to a model must say the character is held.
  const snapshot = buildFightState(gameWindow, {
    turn: 1,
    combo: combatSettings.combo,
    fallbackRange: 1,
    tackleAware: true
  })
  assert.deepStrictEqual(snapshot.me.tackledBy, [20], 'the holder is named')
  assert.strictEqual(snapshot.me.canMove, false, 'and moving is ruled out')
  assert.strictEqual(snapshot.cells.length, 0, 'no cell is offered while held')
  assert.strictEqual(snapshot.spells[0].push, true, 'the push spell is flagged')

  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 700))

  const casts = state.sent.filter((m) => m.name === 'GameActionFightCastRequestMessage')
  assert.strictEqual(casts[0].data.spellId, 300, 'the push is cast first, at the holder')
  assert.strictEqual(casts[0].data.cellId, 294, 'on the monster in contact')
  assert.ok(logs.some((line) => line.includes('to break contact')), 'the intent is logged')
  assert.strictEqual(state.moves.length, 0, 'no tackled move is attempted')

  // Two monsters in contact: pushing one changes nothing, so it is not used.
  state.sent.length = 0
  logs.length = 0
  state.fighters[2].data.disposition.cellId = 266

  state.emit('GameFightTurnEndMessage', { id: 7 })
  state.startTurn(20)
  state.emit('GameFightTurnEndMessage', { id: 20 })
  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 700))

  assert.ok(
    !logs.some((line) => line.includes('to break contact')),
    'no push when several monsters hold the character'
  )

  dispose()
  console.log('ok - push breaks a lone hold')
}

async function testAntiIdle() {
  await bundleModule(path.join(root, 'packages/renderer/src/mods/anti-idle.ts'))
  const { initAntiIdle, dismissInactivityDialog, signalActivity } = await import(
    `${pathToFileURL(path.join(tmpDir, 'anti-idle.js')).href}?t=${Date.now()}`
  )

  // A window showing the warning the game puts up when nothing moves.
  const clicked = []
  const dispatched = []
  const makeElement = (text, tag = 'DIV') => ({
    tagName: tag,
    textContent: text,
    innerText: text,
    offsetParent: {},
    getBoundingClientRect: () => ({ width: 60, height: 20 }),
    contains: () => false,
    click() {
      clicked.push(text)
    }
  })

  const warning = makeElement(
    'Une inactivité prolongée entraîne une déconnexion automatique du serveur.'
  )
  const okButton = makeElement('Ok', 'BUTTON')

  const gameWindow = {
    document: {
      body: {
        dispatchEvent: (event) => dispatched.push(event.type)
      },
      querySelectorAll: (selector) =>
        selector.includes('button') ? [warning, okButton] : [warning]
    }
  }

  assert.strictEqual(dismissInactivityDialog(gameWindow), true, 'the warning is closed')
  assert.deepStrictEqual(clicked, ['Ok'], 'by pressing its Ok button')

  // No warning on screen, nothing to click.
  const quiet = {
    document: {
      body: { dispatchEvent: () => {} },
      querySelectorAll: () => [makeElement('Inventaire')]
    }
  }
  assert.strictEqual(dismissInactivityDialog(quiet), false, 'nothing is clicked without the warning')

  // The sign of life is input the client counts, and nothing it acts on.
  // Node has no DOM event constructors; the renderer does.
  class StubEvent {
    constructor(type) {
      this.type = type
    }
  }
  globalThis.MouseEvent = StubEvent
  globalThis.KeyboardEvent = StubEvent

  signalActivity(gameWindow)
  assert.ok(dispatched.includes('mousemove'), 'a pointer move is sent')
  assert.ok(dispatched.includes('keydown'), 'a modifier key is pressed')
  assert.ok(!dispatched.includes('click'), 'never a click, which would act in game')

  // The watcher closes it on its own, and stops when disposed.
  clicked.length = 0
  const dispose = initAntiIdle(gameWindow, 'tab-1', {
    getSettings: () => ({ antiIdleEnabled: true, antiIdleIntervalSec: 10 }),
    onLog: () => {}
  })
  await new Promise((resolve) => setTimeout(resolve, 5300))
  assert.ok(clicked.length >= 1, 'the watcher closes the warning by itself')

  dispose()
  const seen = clicked.length
  await new Promise((resolve) => setTimeout(resolve, 5300))
  assert.strictEqual(clicked.length, seen, 'and stops once disposed')

  delete globalThis.MouseEvent
  delete globalThis.KeyboardEvent
  console.log('ok - stays connected while idle')
}

async function testSpellPlanner() {
  await bundleModule(path.join(root, 'packages/renderer/src/scripts/zones.ts'))
  const { areaCells, zoneShapeOf } = await import(
    `${pathToFileURL(path.join(tmpDir, 'zones.js')).href}?t=${Date.now()}`
  )
  await bundleModule(path.join(root, 'packages/renderer/src/scripts/spell-planner.ts'))
  const { planTurn, castableCells, hitsFrom } = await import(
    `${pathToFileURL(path.join(tmpDir, 'spell-planner.js')).href}?t=${Date.now()}`
  )
  await bundleModule(path.join(root, 'packages/renderer/src/scripts/cells.ts'))
  const { cellDistance, cellCoordinates, cellFromCoordinates } = await import(
    `${pathToFileURL(path.join(tmpDir, 'cells.js')).href}?t=${Date.now()}`
  )

  // --- the shapes ---
  assert.strictEqual(zoneShapeOf(67), 'circle', 'C is a circle')
  assert.strictEqual(zoneShapeOf(80), 'point', 'P is a point')
  assert.strictEqual(zoneShapeOf(76), 'line', 'L is a line')
  assert.strictEqual(zoneShapeOf(90), 'unknown', 'an unknown letter is reported as such')

  const centre = 280
  const point = areaCells({ shape: 'point', size: 0, minSize: 0 }, 266, centre)
  assert.deepStrictEqual(point, [centre], 'a point covers one cell')

  const circle = areaCells({ shape: 'circle', size: 2, minSize: 0 }, 266, centre)
  assert.ok(circle.includes(centre), 'a circle covers its centre')
  assert.ok(
    circle.every((cell) => cellDistance(cell, centre) <= 2),
    'and nothing beyond its size'
  )

  const ring = areaCells({ shape: 'circle', size: 2, minSize: 1 }, 266, centre)
  assert.ok(!ring.includes(centre), 'a minimum size hollows the middle out')
  assert.ok(ring.length > 0, 'while keeping the rest')

  const lineFrom = 280
  const lineTo = 294
  const line = areaCells({ shape: 'line', size: 3, minSize: 0 }, lineFrom, lineTo)
  assert.ok(line.includes(lineTo), 'a line starts at the aimed cell')
  assert.ok(line.length >= 2, 'and carries on away from the caster')
  const point0 = cellCoordinates(lineFrom)
  const point1 = cellCoordinates(lineTo)
  const dx = Math.sign(point1.x - point0.x)
  const dy = Math.sign(point1.y - point0.y)
  const expected = cellFromCoordinates(point1.x + dx, point1.y + dy)
  if (expected !== null) assert.ok(line.includes(expected), 'in the direction of the cast')

  const cross = areaCells({ shape: 'cross', size: 1, minSize: 0 }, 266, centre)
  assert.strictEqual(cross.length <= 5, true, 'a cross of 1 is the centre and its four arms')

  // --- the fight ---
  const { gameWindow, state } = createFakeGameWindow()
  state.startFight()

  const spellOf = (over) => ({
    id: 1,
    spell: { nameId: 'Test' },
    spellLevel: Object.assign(
      {
        apCost: 3,
        range: 8,
        minRange: 0,
        castInLine: false,
        castInDiagonal: false,
        castTestLos: false,
        needFreeCell: false,
        needTakenCell: false,
        effects: [{ effectId: 100, diceNum: 20, diceSide: 20, zoneShape: 80, zoneSize: 0 }]
      },
      over
    )
  })

  const context = (over) =>
    Object.assign(
      {
        turn: 1,
        actionPoints: 6,
        movementPoints: 0,
        elements: [],
        lastCastTurn: new Map(),
        canMove: false,
        keepDistance: false
      },
      over
    )

  // Two monsters one cell apart: an area spell must catch both with one cast.
  const me = 280
  state.fighters[0].data.disposition.cellId = me
  gameWindow.isoEngine.actorManager.userActor.cellId = me
  const a = 336
  const b = areaCells({ shape: 'circle', size: 1, minSize: 0 }, me, a).find((cell) => cell !== a)
  state.fighters[1].data.disposition.cellId = a
  state.fighters[2].data.disposition.cellId = b

  gameWindow.gui.playerData.characters.mainCharacter.spellData.spells = {
    1: spellOf({
      apCost: 4,
      effects: [{ effectId: 100, diceNum: 18, diceSide: 22, zoneShape: 67, zoneSize: 1 }]
    })
  }

  const area = planTurn(gameWindow, context({}))
  assert.ok(area && area.casts.length > 0, 'a plan is produced')
  assert.strictEqual(area.casts[0].hits.length, 2, 'the area cast catches both monsters')
  assert.ok(
    area.casts[0].reason.includes('2 enemies'),
    'and says so'
  )

  // The same spell must not be aimed where it also catches an ally.
  state.fighters.push({
    id: 30,
    data: {
      teamId: 0,
      alive: true,
      disposition: { cellId: b },
      stats: { lifePoints: 200, maxLifePoints: 200, actionPoints: 6, movementPoints: 3 },
      name: 'Ally'
    }
  })
  const withAlly = planTurn(gameWindow, context({}))
  assert.ok(withAlly && withAlly.casts.length > 0, 'it still casts')
  assert.ok(
    !withAlly.casts[0].friendlyHits.includes(30),
    'but not on a cell whose area covers an ally'
  )
  state.fighters.pop()

  // Constraints are the spell's own: minimum range, straight line, free cell.
  const near = {
    id: 2,
    range: 6,
    minRange: 3,
    castInLine: true,
    castInDiagonal: false,
    needsLineOfSight: false,
    needsFreeCell: false,
    needsTakenCell: false,
    zone: { shape: 'point', size: 0, minSize: 0 }
  }
  const cells = castableCells(gameWindow, near, me, new Set())
  assert.ok(cells.length > 0, 'a line spell has somewhere to go')
  assert.ok(
    cells.every((cell) => cellDistance(me, cell) >= 3 && cellDistance(me, cell) <= 6),
    'the minimum and maximum range hold'
  )

  const mustBeFree = castableCells(
    gameWindow,
    Object.assign({}, near, { castInLine: false, needsFreeCell: true }),
    me,
    new Set([a])
  )
  assert.ok(!mustBeFree.includes(a), 'a spell needing a free cell skips an occupied one')

  const mustBeTaken = castableCells(
    gameWindow,
    Object.assign({}, near, { castInLine: false, needsTakenCell: true }),
    me,
    new Set([a])
  )
  assert.deepStrictEqual(mustBeTaken, [a], 'a spell needing someone only aims at them')

  // Damage is not wasted: a second cast goes elsewhere once one would kill.
  state.fighters[1].data.stats.lifePoints = 15
  state.fighters[2].data.stats.lifePoints = 300
  gameWindow.gui.playerData.characters.mainCharacter.spellData.spells = {
    1: spellOf({ apCost: 3, effects: [{ effectId: 100, diceNum: 40, diceSide: 40, zoneSize: 0 }] })
  }
  const spread = planTurn(gameWindow, context({ actionPoints: 6 }))
  assert.ok(spread && spread.casts.length === 2, 'the action points buy two casts')
  assert.notStrictEqual(
    spread.casts[0].cellId,
    spread.casts[1].cellId,
    'the second cast is not thrown at a monster the first already kills'
  )

  // Moving is considered when it unlocks a better cast.
  // Seven cells away: out of a range-4 spell, but four movement points bring
  // the character close enough.
  state.fighters[1].data.stats.lifePoints = 300
  state.fighters[1].data.disposition.cellId = 381
  state.fighters[2].data.disposition.cellId = 382
  assert.strictEqual(cellDistance(me, 381), 7, 'the target sits just out of reach')
  gameWindow.gui.playerData.characters.mainCharacter.spellData.spells = {
    1: spellOf({ apCost: 3, range: 4, effects: [{ effectId: 100, diceNum: 30, diceSide: 30, zoneSize: 0 }] })
  }

  const still = planTurn(gameWindow, context({ movementPoints: 0, canMove: false }))
  const moving = planTurn(gameWindow, context({ movementPoints: 4, canMove: true }))
  assert.ok(
    (still?.casts.length ?? 0) === 0,
    'out of range, standing still casts nothing'
  )
  assert.ok(
    moving && moving.actions.some((action) => action.type === 'move'),
    'but a move is planned to reach them'
  )
  assert.ok(moving.casts.length > 0, 'and the cast follows')
  const order = moving.actions.map((action) => action.type)
  assert.strictEqual(order[0], 'move', 'the points are spent before the first spell here')

  // An element the user unticked is left alone.
  const noFire = planTurn(gameWindow, context({ movementPoints: 4, canMove: true, elements: ['water'] }))
  assert.ok((noFire?.casts.length ?? 0) === 0, 'a fire spell is skipped when only water is allowed')

  // Points can also be kept for later: cast, step, cast again.
  state.fighters[1].data.disposition.cellId = 336
  state.fighters[1].data.stats.lifePoints = 300
  state.fighters[2].data.disposition.cellId = 470
  state.fighters[2].data.stats.lifePoints = 300
  gameWindow.gui.playerData.characters.mainCharacter.spellData.spells = {
    1: spellOf({
      apCost: 3,
      range: 5,
      maxCastPerTarget: 1,
      effects: [{ effectId: 100, diceNum: 30, diceSide: 30, zoneSize: 0 }]
    })
  }

  const interleaved = planTurn(
    gameWindow,
    context({ actionPoints: 6, movementPoints: 6, canMove: true })
  )
  if (interleaved) {
    const kinds = interleaved.actions.map((action) => action.type)
    const firstCast = kinds.indexOf('cast')
    const laterMove = kinds.indexOf('move', firstCast === -1 ? 0 : firstCast)
    assert.ok(
      firstCast !== -1,
      'a spell is cast'
    )
    if (laterMove !== -1) {
      assert.ok(laterMove > firstCast, 'and the points may be spent after it')
    }
  }

  console.log('ok - the AI plans spells, areas and position together')
}

async function testChallengeRules() {
  await bundleModule(path.join(root, 'packages/renderer/src/scripts/fight-state.ts'))
  const { deriveChallengeRules } = await import(
    `${pathToFileURL(path.join(tmpDir, 'fight-state.js')).href}?t=${Date.now()}`
  )
  await bundleModule(path.join(root, 'packages/renderer/src/scripts/turn-plan.ts'))
  const { validatePlan } = await import(
    `${pathToFileURL(path.join(tmpDir, 'turn-plan.js')).href}?t=${Date.now()}`
  )

  // The wording is what says what a challenge forbids, in either language.
  const still = deriveChallengeRules([
    { id: 1, name: 'Statique', description: 'Ne pas se déplacer durant le combat', targetId: null }
  ])
  assert.strictEqual(still.noMove, true, 'a static challenge forbids moving')

  const focus = deriveChallengeRules([
    { id: 2, name: 'Focus', description: 'Attaquer un seul ennemi', targetId: 21 }
  ])
  assert.strictEqual(focus.singleTarget, true, 'a focus challenge allows one target')
  assert.strictEqual(focus.focusTargetId, 21, 'and names it when the fight does')

  const english = deriveChallengeRules([
    { id: 3, name: 'Untouchable', description: 'Do not move and stay away from melee', targetId: null }
  ])
  assert.strictEqual(english.noMove, true, 'English wording works too')
  assert.strictEqual(english.avoidMelee, true, 'melee is spotted')

  assert.strictEqual(
    deriveChallengeRules([{ id: 4, name: 'Riche', description: 'Gagner plus de kamas', targetId: null }]).noMove,
    false,
    'an unrelated challenge constrains nothing'
  )

  // And the plan is held to them, whatever the model asked for.
  const state = {
    turn: 1,
    me: { id: 7, name: 'me', cellId: 280, life: 100, maxLife: 100, ap: 6, mp: 3, tackledBy: [], canMove: true },
    spells: [{ id: 161, name: 'Bolt', range: 6, minRange: 0, targets: [1, 2], self: false, push: false }],
    enemies: [
      { n: 1, id: 20, name: 'A', cellId: 294, x: 0, y: 0, life: 100, maxLife: 100, distance: 1, lineOfSight: true, aligned: true },
      { n: 2, id: 21, name: 'B', cellId: 300, x: 0, y: 0, life: 100, maxLife: 100, distance: 2, lineOfSight: true, aligned: true }
    ],
    allies: [],
    cells: [{ cellId: 266, cost: 1, enemyDistance: 2, sees: [20], alignedWith: [] }],
    challenges: [{ id: 2, name: 'Focus', description: 'Attaquer un seul ennemi', targetId: 21 }],
    challengeRules: { noMove: true, singleTarget: true, avoidMelee: false, focusTargetId: 21 }
  }

  const { actions, rejected } = validatePlan(
    {
      actions: [
        { type: 'move', cellId: 266 },
        { type: 'cast', spellId: 161, targetId: 20 },
        { type: 'cast', spellId: 161, targetId: 21 }
      ]
    },
    state
  )

  assert.deepStrictEqual(
    actions,
    [{ type: 'cast', spellId: 161, targetId: 21 }],
    'only the cast the challenges allow survives'
  )
  assert.ok(rejected.some((line) => line.includes('forbids moving')), 'the move is refused')
  assert.ok(rejected.some((line) => line.includes('names another target')), 'the wrong target is refused')

  console.log('ok - challenges constrain the turn')
}

async function testTurnPlanValidation() {
  await bundleModule(path.join(root, 'packages/renderer/src/scripts/turn-plan.ts'))
  const { validatePlan, parsePlan } = await import(
    `${pathToFileURL(path.join(tmpDir, 'turn-plan.js')).href}?t=${Date.now()}`
  )

  const state = {
    turn: 1,
    me: { id: 7, name: 'Tester', cellId: 280, life: 500, maxLife: 500, ap: 6, mp: 3, tackledBy: [], canMove: true },
    spells: [
      { id: 161, name: 'Bolt', range: 6, minRange: 0, targets: [1], self: false, push: false },
      { id: 100, name: 'Buff', range: 0, minRange: 0, targets: [], self: true, push: false }
    ],
    enemies: [
      { n: 1, id: 20, name: 'Close', cellId: 294, x: 0, y: 0, life: 100, maxLife: 200, distance: 1, lineOfSight: true, aligned: true },
      { n: 2, id: 21, name: 'Far', cellId: 400, x: 0, y: 0, life: 50, maxLife: 200, distance: 12, lineOfSight: false, aligned: false }
    ],
    allies: [],
    cells: [
      { cellId: 266, cost: 1, enemyDistance: 2, sees: [20], alignedWith: [20] },
      { cellId: 252, cost: 2, enemyDistance: 3, sees: [20], alignedWith: [] }
    ],
    challenges: [],
    challengeRules: { noMove: false, singleTarget: false, avoidMelee: false, focusTargetId: null }
  }

  const { actions, rejected } = validatePlan(
    {
      actions: [
        { type: 'move', cellId: 266 },
        { type: 'move', cellId: 252 },
        { type: 'cast', spellId: 161, targetId: 20 },
        { type: 'cast', spellId: 100 },
        { type: 'cast', spellId: 999, targetId: 20 },

        { type: 'dance' }
      ]
    },
    state
  )

  assert.deepStrictEqual(
    actions,
    [
      { type: 'move', cellId: 266 },
      { type: 'cast', spellId: 161, targetId: 20 },
      { type: 'cast', spellId: 100 }
    ],
    'only the legal actions survive, in order'
  )
  assert.strictEqual(rejected.length, 3, 'the others are reported')
  assert.ok(rejected.some((line) => line.includes('only one move per turn')), 'a second move is refused')
  assert.ok(rejected.some((line) => line.includes('not in the combo')), 'an unknown spell is refused')


  // A cast aimed out of reach is re-aimed at an enemy the spell can hit: a
  // wasted turn is worse than a different target.
  const stillPut = validatePlan({ actions: [{ type: 'cast', spellId: 161, targetId: 2 }] }, state)
  assert.deepStrictEqual(
    stillPut.actions,
    [{ type: 'cast', spellId: 161, targetId: 20 }],
    'the cast is re-aimed rather than lost'
  )
  assert.ok(stillPut.rejected[0].includes('out of reach'), 'and says what happened')

  // An invented target is repaired the same way — this is what a small model does.
  const invented = validatePlan({ actions: [{ type: 'cast', spellId: 161, targetId: 0 }] }, state)
  assert.deepStrictEqual(
    invented.actions,
    [{ type: 'cast', spellId: 161, targetId: 20 }],
    'a target the model made up still produces an attack'
  )

  // The parser copes with a model wrapping its JSON in prose.
  const parsed = parsePlan('Sure! {"actions":[{"type":"cast","spellId":161,"targetId":20}],"reason":"hit"} done')
  assert.strictEqual(parsed.actions.length, 1, 'the plan is extracted from the prose')
  assert.strictEqual(parsed.reason, 'hit')
  assert.strictEqual(parsePlan('no json here'), null, 'garbage is refused')

  console.log('ok - turn plan validation')
}

async function testConnectionCheck() {
  await bundleModule(path.join(root, 'packages/renderer/src/scripts/game-bridge.ts'))
  const { isConnected } = await import(
    `${pathToFileURL(path.join(tmpDir, 'game-bridge.js')).href}?t=${Date.now()}`
  )

  const inGame = {
    gui: { playerData: { characterBaseInformations: { name: 'Romikie' } } },
    isoEngine: { mapRenderer: { mapId: 1000, map: {} } }
  }

  assert.strictEqual(isConnected(inGame), true, 'being in game is enough, with no indicator')

  assert.strictEqual(
    isConnected({ ...inGame, gui: { ...inGame.gui, isConnected: () => false } }),
    true,
    'a character on a map wins over a build-specific false'
  )

  assert.strictEqual(
    isConnected({ gui: { isConnected: () => false }, isoEngine: {} }),
    false,
    'no character and an explicit false is disconnected'
  )

  assert.strictEqual(
    isConnected({ gui: {}, isoEngine: {} }),
    true,
    'a window with no indicator at all is treated as usable'
  )

  assert.strictEqual(
    isConnected({ gui: {}, isoEngine: {}, dofus: { connectionManager: { connected: true } } }),
    true,
    'the connection manager flag is honoured'
  )

  assert.strictEqual(
    isConnected({ gui: { isConnected: true }, isoEngine: {} }),
    true,
    'isConnected as a boolean property is honoured'
  )

  console.log('ok - connection check')
}

async function testTemplatesCompile() {
  await bundleModule(path.join(root, 'packages/renderer/src/scripts/templates.ts'))
  const { SCRIPT_TEMPLATES } = await import(
    `${pathToFileURL(path.join(tmpDir, 'templates.js')).href}?t=${Date.now()}`
  )

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  assert.ok(SCRIPT_TEMPLATES.length > 0, 'templates are exported')

  for (const template of SCRIPT_TEMPLATES) {
    try {
      new AsyncFunction('api', `"use strict";\n${template.source}\n`)
    } catch (err) {
      assert.fail(`Template "${template.name}" does not compile: ${err.message}`)
    }
  }

  console.log(`ok - ${SCRIPT_TEMPLATES.length} templates compile`)
}

async function testCombatAi() {
  await bundleModule(path.join(root, 'packages/renderer/src/mods/combat-ai.ts'))
  const { initCombatAi } = await import(`${pathToFileURL(combatBundlePath).href}?t=${Date.now()}`)

  const { gameWindow, state } = createFakeGameWindow()
  state.startFight()

  const logs = []
  const combatSettings = {
    enabled: true,
    combo: [{ id: 161, name: 'Pressure' }, { id: 165, name: 'Bramble' }],
    turnCombos: [],
    targetStrategy: 'weakest',
    approachEnemies: false,
    // Long enough that both enemies are reachable, so the strategy decides.
    defaultSpellRange: 12,
    preferLineUp: false,
    positioning: 'close-in',
    autoReady: true,
    turnStartDelayMs: 0,
    castDelayMs: 0,
    readyDelayMs: 0,
    placeBeforeReady: false,
    randomJitterMs: 0,
    endTurnAfterCombo: true,
    closeEndScreens: true
  }

  const dispose = initCombatAi(gameWindow, 'tab-1', {
    getSettings: () => combatSettings,
    onLog: (message) => logs.push(message)
  })

  state.emit('GameFightStartingMessage', {})
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.ok(
    state.sent.some((message) => message.name === 'GameFightReadyMessage'),
    'the AI readies up when a fight starts'
  )

  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 120))

  const casts = state.sent.filter((message) => message.name === 'GameActionFightCastRequestMessage')
  assert.deepStrictEqual(casts.map((c) => c.data.spellId), [161, 165], 'the combo is cast in order')
  assert.strictEqual(casts[0].data.cellId, 350, 'the weakest enemy cell is targeted')
  assert.ok(
    state.sent.some((message) => message.name === 'GameFightTurnFinishMessage'),
    'the turn is passed once the combo is done'
  )

  // A turn belonging to another fighter must be ignored.
  const before = state.sent.length
  state.startTurn(20)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.strictEqual(state.sent.length, before, 'the AI only plays its own turn')

  // Disabling it stops any further action.
  combatSettings.enabled = false
  state.startTurn(7)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.strictEqual(state.sent.length, before, 'a disabled AI does nothing')

  // End of fight: the results and level-up screens must be dismissed.
  combatSettings.enabled = true
  state.endFight()
  await new Promise((resolve) => setTimeout(resolve, 1200))

  assert.ok(state.closedWindows.includes('fightEnd'), 'the results screen is closed')
  assert.ok(state.closedWindows.includes('levelUp'), 'the level-up window is closed')
  assert.ok(!state.closedWindows.includes('inventory'), 'other windows stay open')
  assert.ok(logs.some((line) => line.includes('Closed')), 'the dismissal is logged')

  dispose()
  console.log('ok - combat AI turn')
}

async function main() {
  const { ScriptRunner } = await bundleEngine()

  await testSimpleRun(ScriptRunner)
  await testMove(ScriptRunner)
  await testTravel(ScriptRunner)
  await testLoopAndStop(ScriptRunner)
  await testRuntimeError(ScriptRunner)
  await testSyntaxError(ScriptRunner)
  await testApiStop(ScriptRunner)
  await testListenersCleanedUp(ScriptRunner)
  await testFightCombo(ScriptRunner)
  await testTargetStrategies(ScriptRunner)
  await testCombatAi()
  await testMonsterHunt(ScriptRunner)
  await testAttackUsesTheGameFlow(ScriptRunner)
  await testAttackFallsBackToProtocol(ScriptRunner)
  await testAttackKeepsProbingAndReports(ScriptRunner)
  await testAttackApproach(ScriptRunner)
  await testClosePopups(ScriptRunner)
  await testTurnCombos()
  await testApproachWithMp()
  await testSelfCastAndLineUp()
  await testRangeAndShortWalk()
  await testKitingAndSingleMove()
  await testSpreadCasts()
  await testTackleAwareness()
  await testFightMovementGoesThroughTheServer()
  await testHumanDelays()
  await testTurnAlwaysPassed()
  await testTurnSynchronisation()
  await testMovementDiscovery(ScriptRunner)
  await testMovementReportsNoEntryPoint(ScriptRunner)
  await testModelBrain()
  await testPlacementAndLineOfSight()
  await testPushBreaksMelee()
  await testAntiIdle()
  await testSpellPlanner()
  await testChallengeRules()
  await testTurnPlanValidation()
  await testConnectionCheck()
  await testTemplatesCompile()

  console.log('\nAll script engine tests passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
