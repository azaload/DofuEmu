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
    { id: 7, data: { teamId: 0, alive: true, disposition: { cellId: 280 }, stats: { lifePoints: 500, maxLifePoints: 500 }, name: 'Tester' } },
    { id: 20, data: { teamId: 1, alive: true, disposition: { cellId: 294 }, stats: { lifePoints: 120, maxLifePoints: 200 }, name: 'Close' } },
    { id: 21, data: { teamId: 1, alive: true, disposition: { cellId: 350 }, stats: { lifePoints: 40, maxLifePoints: 200 }, name: 'Weak' } }
  ]

  const gameWindow = {
    dofus: {
      connectionManager,
      sendMessage: (name, data) => {
        sent.push({ name, data })
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
      on: connectionManager.on
    },
    isoEngine: {
      mapRenderer: { mapId: MAP_A, map: buildMap(MAP_A), interactiveElements: {} },
      actorManager: { userActor: { cellId: 100 } },
      moveTo: (cellId) => {
        setTimeout(() => {
          state.cellId = cellId
          gameWindow.isoEngine.actorManager.userActor.cellId = cellId
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

  state.fighters = fighters
  state.startFight = () => {
    gameWindow.gui.fightManager.isFightStarted = true
    gameWindow.gui.playerData.isFighting = true
  }
  state.startTurn = (fighterId) => state.emit('GameFightTurnStartMessage', { id: fighterId })

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

async function run(ScriptRunner, source, extra = {}) {
  const { gameWindow, state } = createFakeGameWindow()
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

async function testCombatAi() {
  await bundleModule(path.join(root, 'packages/renderer/src/mods/combat-ai.ts'))
  const { initCombatAi } = await import(`${pathToFileURL(combatBundlePath).href}?t=${Date.now()}`)

  const { gameWindow, state } = createFakeGameWindow()
  state.startFight()

  const logs = []
  const combatSettings = {
    enabled: true,
    combo: [{ id: 161, name: 'Pressure' }, { id: 165, name: 'Bramble' }],
    targetStrategy: 'weakest',
    autoReady: true,
    turnStartDelayMs: 0,
    castDelayMs: 0,
    endTurnAfterCombo: true
  }

  const dispose = initCombatAi(gameWindow, 'tab-1', {
    getSettings: () => combatSettings,
    onLog: (message) => logs.push(message)
  })

  state.emit('GameFightStartingMessage', {})
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

  console.log('\nAll script engine tests passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
