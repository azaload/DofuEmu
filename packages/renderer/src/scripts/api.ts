import {
  addListener,
  availableMoveMethods,
  callMoveMethod,
  getCellId,
  getCharacter,
  getConnectionManager,
  getGuiEmitter,
  getInteractiveElements,
  getMapChangeCells,
  describeMapSources,
  getMapInfo,
  getMonsterGroups,
  isConnected,
  isInFight,
  isMoving,
  parseDirection,
  MOVE_METHODS,
  sendMessage,
  type Direction,
  type EventEmitterLike,
  type MonsterGroup
} from './game-bridge'
import {
  attackOwners,
  callWithGroup,
  describeGameApi,
  findAttackButton,
  requestAttack,
  TAP_METHODS,
  visibleLabels
} from './attack'
import { findCellNextTo, reachableCells } from './cells'
import { closeUiPopups } from './ui-bridge'
import {
  castSpell,
  cellDistance,
  finishTurn,
  getAllies,
  getEnemies,
  getFightManager,
  getFighters,
  getMyFighter,
  getMyFighterId,
  getSpells,
  isFightStarted,
  pickTarget,
  setFightReady,
  type Fighter
} from './fight-bridge'
import {
  ScriptAbortError,
  type AttackOptions,
  type CastOptions,
  type FightApi,
  type MonsterFilter,
  type MoveOptions,
  type ScriptApi,
  type ScriptRuntimeContext,
  type TargetStrategy,
  type WaitForMessageOptions,
  type WaitUntilOptions
} from './types'

const DEFAULT_MOVE_TIMEOUT = 12000
/** How long a walk has to visibly start before another entry point is tried. */
const MOVE_START_TIMEOUT = 900
const DEFAULT_WAIT_TIMEOUT = 15000
const DEFAULT_POLL_INTERVAL = 200
const DEFAULT_TRAVEL_STEPS = 60
/** Cells a character may walk through on one map, outside fights. */
const ROAM_STEPS = 60
const DEFAULT_CAST_TIMEOUT = 4000
const DEFAULT_ATTACK_TIMEOUT = 20000
const ATTACK_APPROACH_TIMEOUT = 12000
const DEFAULT_TURN_TIMEOUT = 300000
const TURN_POLL_INTERVAL = 400
const BROADCAST_PREFIX = 'dofemu-script:'

function format(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg
      if (arg instanceof Error) return arg.message
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    })
    .join(' ')
}

export function createScriptApi(ctx: ScriptRuntimeContext): ScriptApi {
  const { gameWindow, settings, signal } = ctx

  const throwIfAborted = () => {
    if (signal.aborted) throw new ScriptAbortError()
  }

  const wait = (ms: number): Promise<void> => {
    throwIfAborted()
    const delay = Math.max(0, Math.floor(ms))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, delay)
      const onAbort = () => {
        clearTimeout(timer)
        reject(new ScriptAbortError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  const random = (min: number, max: number) => {
    const low = Math.min(min, max)
    const high = Math.max(min, max)
    return Math.floor(low + Math.random() * (high - low + 1))
  }

  /** Small human-looking pause inserted after each game action. */
  const actionDelay = async () => {
    if (!settings.humanDelays) return
    const min = Math.max(0, settings.minActionDelayMs)
    const max = Math.max(min, settings.maxActionDelayMs)
    if (max <= 0) return
    await wait(random(min, max))
  }

  const guardFight = () => {
    if (settings.stopOnFight && isInFight(gameWindow)) {
      throw new ScriptAbortError('Stopped: character entered a fight')
    }
  }

  const waitUntil = async (
    predicate: () => boolean | Promise<boolean>,
    options: WaitUntilOptions = {}
  ): Promise<void> => {
    const timeout = options.timeout ?? DEFAULT_WAIT_TIMEOUT
    const interval = options.interval ?? DEFAULT_POLL_INTERVAL
    const deadline = Date.now() + timeout

    for (;;) {
      throwIfAborted()
      if (await predicate()) return
      if (Date.now() >= deadline) {
        throw new Error(options.message ?? `Timed out after ${timeout}ms waiting for a condition`)
      }
      await wait(interval)
    }
  }

  const emitterFor = (source: 'connection' | 'gui'): EventEmitterLike | null =>
    source === 'gui' ? getGuiEmitter(gameWindow) : getConnectionManager(gameWindow)

  const addListenerWithCleanup = (
    source: 'connection' | 'gui',
    event: string,
    handler: (message: unknown) => void
  ) => {
    const dispose = addListener(emitterFor(source), event, (...args) => handler(args[0] ?? {}))
    ctx.registerCleanup(dispose)
  }

  const on = <T,>(
    name: string,
    handler: (message: T) => void,
    source: 'connection' | 'gui' = 'connection'
  ): (() => void) => {
    const dispose = addListener(emitterFor(source), name, (...args) => {
      handler((args[0] ?? {}) as T)
    })
    ctx.registerCleanup(dispose)
    return dispose
  }

  const waitForMessage = <T,>(name: string, options: WaitForMessageOptions<T> = {}): Promise<T> => {
    throwIfAborted()
    const timeout = options.timeout ?? DEFAULT_WAIT_TIMEOUT

    return new Promise<T>((resolve, reject) => {
      const finish = (fn: () => void) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        dispose()
        fn()
      }

      const dispose = addListener(emitterFor(options.source ?? 'connection'), name, (...args) => {
        const message = (args[0] ?? {}) as T
        if (options.filter && !options.filter(message)) return
        finish(() => resolve(message))
      })

      const timer = setTimeout(
        () => finish(() => reject(new Error(`Timed out after ${timeout}ms waiting for ${name}`))),
        timeout
      )

      const onAbort = () => finish(() => reject(new ScriptAbortError()))
      signal.addEventListener('abort', onAbort, { once: true })
      ctx.registerCleanup(dispose)
    })
  }

  const currentMapId = () => getMapInfo(gameWindow).id

  const waitForMapId = (mapId: number, timeout: number) =>
    waitUntil(() => currentMapId() === mapId, {
      timeout,
      message: `Timed out after ${timeout}ms waiting to arrive on map ${mapId}`
    })

  /**
   * Entry point that actually moved the character on this build, remembered
   * for the rest of the session: the client is minified and names differ, so
   * the working one is found by effect rather than assumed.
   */
  let workingMoveMethod: string | null = null

  const cellChanged = async (from: number | null, within: number): Promise<boolean> => {
    const deadline = Date.now() + within
    while (Date.now() < deadline) {
      throwIfAborted()
      if (getCellId(gameWindow) !== from) return true
      await wait(80)
    }
    return false
  }

  const startWalk = async (cellId: number): Promise<string | null> => {
    const from = getCellId(gameWindow)

    // Once one is known to work, stop probing.
    const order = workingMoveMethod
      ? [workingMoveMethod, ...MOVE_METHODS.filter((method) => method !== workingMoveMethod)]
      : [...MOVE_METHODS]

    for (const method of order) {
      if (!callMoveMethod(gameWindow, method, cellId)) continue
      if (await cellChanged(from, MOVE_START_TIMEOUT)) {
        workingMoveMethod = method
        return method
      }
    }

    return null
  }

  const moveToCell = async (cellId: number, options: MoveOptions = {}): Promise<number> => {
    throwIfAborted()
    guardFight()

    const timeout = options.timeout ?? DEFAULT_MOVE_TIMEOUT
    if (getCellId(gameWindow) === cellId) return cellId

    const method = await startWalk(cellId)

    if (!method) {
      const known = availableMoveMethods(gameWindow)
      throw new Error(
        known.length > 0
          ? `The character did not move (tried ${known.join(', ')}) — the path may be blocked, or this build needs another entry point; run api.inspect('move|walk|path|cell') to list them`
          : "No movement entry point on this build — run api.inspect('move|walk|path|cell') to list what it exposes"
      )
    }

    await waitUntil(() => getCellId(gameWindow) === cellId, {
      timeout,
      message: `Timed out after ${timeout}ms walking to cell ${cellId} with ${method}()`
    })

    await actionDelay()
    return cellId
  }

  const changeMap = async (mapId: number, options: MoveOptions = {}): Promise<number> => {
    throwIfAborted()
    guardFight()

    const timeout = options.timeout ?? DEFAULT_MOVE_TIMEOUT
    if (currentMapId() === mapId) return mapId

    sendMessage(gameWindow, 'ChangeMapMessage', { mapId })
    await waitForMapId(mapId, timeout)
    await actionDelay()
    return mapId
  }

  const move = async (direction: Direction | string, options: MoveOptions = {}): Promise<number> => {
    throwIfAborted()
    guardFight()

    const dir = parseDirection(String(direction))
    const map = getMapInfo(gameWindow)
    const targetMapId = map.neighbours[dir]

    if (targetMapId === null) {
      throw new Error(`Map ${map.id ?? '?'} has no ${dir} neighbour`)
    }

    const exitCells = getMapChangeCells(gameWindow, dir)
    const from = getCellId(gameWindow)

    if (exitCells.length > 0 && from !== null) {
      // Pick an exit a path can actually reach: on maps cluttered with
      // buildings the closest one in a straight line is often behind a wall.
      const reachable = reachableCells(gameWindow, from, ROAM_STEPS)
      const options_ = exitCells
        .map((cellId) => reachable.get(cellId))
        .filter((entry): entry is NonNullable<typeof entry> => !!entry)
        .sort((a, b) => a.cost - b.cost)

      if (options_.length === 0) {
        ctx.hooks.onLog(
          'warn',
          `No walkable path to a ${dir} exit on map ${map.id ?? '?'} — trying the closest one anyway`
        )
        const fallback = exitCells.reduce((best, candidate) =>
          Math.abs(candidate - from) < Math.abs(best - from) ? candidate : best
        )
        await moveToCell(fallback, options).catch(() => undefined)
      } else {
        let walked = false
        for (const candidate of options_.slice(0, 3)) {
          try {
            await moveToCell(candidate.cellId, options)
            walked = true
            break
          } catch (err) {
            if (err instanceof ScriptAbortError) throw err
            ctx.hooks.onLog('warn', `Exit cell ${candidate.cellId} could not be reached, trying another`)
          }
        }
        if (!walked) {
          throw new Error(
            `Could not reach any ${dir} exit on map ${map.id ?? '?'} — the way is blocked`
          )
        }
      }
    } else if (exitCells.length > 0) {
      await moveToCell(exitCells[0], options)
    }

    return changeMap(targetMapId, options)
  }

  const movePath = async (
    path: string | Array<Direction | string>,
    options: MoveOptions = {}
  ): Promise<number> => {
    const steps = Array.isArray(path) ? path : path.split(/[\s,]+/).filter(Boolean)
    let mapId = currentMapId() ?? -1
    for (const step of steps) {
      mapId = await move(step, options)
    }
    return mapId
  }

  const travelTo = async (
    x: number,
    y: number,
    options: MoveOptions & { maxSteps?: number } = {}
  ): Promise<number> => {
    const maxSteps = options.maxSteps ?? DEFAULT_TRAVEL_STEPS

    for (let step = 0; step < maxSteps; step++) {
      throwIfAborted()
      const map = getMapInfo(gameWindow)

      if (map.x === null || map.y === null) {
        throw new Error('Current map has no coordinates — use api.move() or api.changeMap() instead')
      }
      if (map.x === x && map.y === y) return map.id ?? -1

      const dx = x - map.x
      const dy = y - map.y
      const horizontal: Direction = dx > 0 ? 'right' : 'left'
      const vertical: Direction = dy > 0 ? 'bottom' : 'top'
      const order =
        Math.abs(dx) >= Math.abs(dy)
          ? [dx !== 0 ? horizontal : vertical, dy !== 0 ? vertical : horizontal]
          : [dy !== 0 ? vertical : horizontal, dx !== 0 ? horizontal : vertical]

      let moved = false
      for (const direction of order) {
        if (map.neighbours[direction] === null) continue
        await move(direction, options)
        moved = true
        break
      }

      if (!moved) {
        throw new Error(`Stuck at [${map.x}, ${map.y}] — no usable neighbour towards [${x}, ${y}]`)
      }
    }

    throw new Error(`Could not reach [${x}, ${y}] within ${maxSteps} map changes`)
  }

  const interact = (elementId: number, skillUid = 0) => {
    throwIfAborted()
    sendMessage(gameWindow, 'InteractiveUseRequestMessage', {
      elemId: elementId,
      skillInstanceUid: skillUid
    })
  }

  const gather = async (options: MoveOptions = {}): Promise<boolean> => {
    throwIfAborted()
    guardFight()

    const element = getInteractiveElements(gameWindow).find((candidate) => {
      const skills = candidate.enabledSkills
      return Array.isArray(skills) && skills.length > 0
    })

    if (!element) return false

    const elementId = Number(element.elementId ?? element.id)
    const skills = element.enabledSkills as Array<Record<string, unknown>>
    const skillUid = Number(skills[0]?.skillInstanceUid ?? skills[0]?.skillId ?? 0)
    if (!Number.isFinite(elementId)) return false

    interact(elementId, Number.isFinite(skillUid) ? skillUid : 0)

    try {
      await waitForMessage('InteractiveUseEndedMessage', {
        timeout: options.timeout ?? DEFAULT_MOVE_TIMEOUT
      })
    } catch (err) {
      if (err instanceof ScriptAbortError) throw err
      return false
    }

    await actionDelay()
    return true
  }

  /**
   * Whose turn it is. The fight manager exposes it on some builds; otherwise we
   * follow the turn messages ourselves.
   */
  let trackedTurnFighterId: number | null = null
  let turnTrackingStarted = false

  const startTurnTracking = () => {
    if (turnTrackingStarted) return
    turnTrackingStarted = true
    for (const source of ['gui', 'connection'] as const) {
      addListenerWithCleanup(source, 'GameFightTurnStartMessage', (message) => {
        trackedTurnFighterId = (message as { id?: number }).id ?? null
      })
      addListenerWithCleanup(source, 'GameFightTurnEndMessage', () => {
        trackedTurnFighterId = null
      })
      addListenerWithCleanup(source, 'GameFightEndMessage', () => {
        trackedTurnFighterId = null
      })
    }
  }

  const currentTurnFighterId = (): number | null => {
    const manager = getFightManager(gameWindow) as Record<string, unknown> | null
    const fromManager = manager?.currentFighterId ?? manager?.currentPlayerId
    if (typeof fromManager === 'number' && Number.isFinite(fromManager)) return fromManager
    return trackedTurnFighterId
  }

  const targetCellId = (target?: Fighter | number): number | null => {
    if (typeof target === 'number') return target
    if (target) return target.cellId
    return null
  }

  const chooseTarget = (strategy: TargetStrategy = 'nearest') => pickTarget(gameWindow, strategy)

  const fight: FightApi = {
    isActive: () => isFightStarted(gameWindow),
    isMyTurn: () => {
      startTurnTracking()
      const myId = getMyFighterId(gameWindow)
      return myId !== null && currentTurnFighterId() === myId
    },
    me: () => getMyFighter(gameWindow),
    fighters: () => getFighters(gameWindow),
    enemies: () => getEnemies(gameWindow),
    allies: () => getAllies(gameWindow),
    spells: () => getSpells(gameWindow),
    target: chooseTarget,
    distanceTo: (target) => {
      const me = getMyFighter(gameWindow)
      const cell = targetCellId(target)
      if (!me || me.cellId === null || cell === null) return null
      return cellDistance(me.cellId, cell)
    },

    cast: async (spellId, target, options: CastOptions = {}) => {
      throwIfAborted()
      const cell = targetCellId(target) ?? targetCellId(chooseTarget() ?? undefined)
      if (cell === null) throw new Error('No target cell for the spell')

      const myId = getMyFighterId(gameWindow)
      const confirmation = waitForMessage<{ sourceId?: number }>('GameActionFightSpellCastMessage', {
        timeout: options.timeout ?? DEFAULT_CAST_TIMEOUT,
        filter: (message) => myId === null || message.sourceId === myId
      })

      castSpell(gameWindow, spellId, cell)

      let confirmed = true
      try {
        await confirmation
      } catch (err) {
        if (err instanceof ScriptAbortError) throw err
        confirmed = false
      }

      await actionDelay()
      return confirmed
    },

    endTurn: () => {
      throwIfAborted()
      finishTurn(gameWindow)
    },

    ready: (isReady = true) => {
      throwIfAborted()
      setFightReady(gameWindow, isReady)
    },

    waitForTurn: (options = {}) => {
      startTurnTracking()
      return waitUntil(() => fight.isMyTurn(), {
        timeout: options.timeout ?? DEFAULT_TURN_TIMEOUT,
        interval: options.interval ?? TURN_POLL_INTERVAL,
        message: options.message ?? 'Timed out waiting for our turn'
      })
    },

    waitForTurnEnd: (options = {}) => {
      startTurnTracking()
      return waitUntil(() => !fight.isMyTurn(), {
        timeout: options.timeout ?? DEFAULT_TURN_TIMEOUT,
        interval: options.interval ?? TURN_POLL_INTERVAL,
        message: options.message ?? 'Timed out waiting for the turn to end'
      })
    },

    waitForFight: (options = {}) =>
      waitUntil(() => isFightStarted(gameWindow), {
        timeout: options.timeout ?? DEFAULT_TURN_TIMEOUT,
        interval: options.interval ?? TURN_POLL_INTERVAL,
        message: options.message ?? 'Timed out waiting for a fight to start'
      }),

    waitForFightEnd: (options = {}) =>
      waitUntil(() => !isFightStarted(gameWindow), {
        timeout: options.timeout ?? DEFAULT_TURN_TIMEOUT,
        interval: options.interval ?? TURN_POLL_INTERVAL,
        message: options.message ?? 'Timed out waiting for the fight to end'
      })
  }

  const monsters = (filter: MonsterFilter = {}): MonsterGroup[] => {
    const groups = getMonsterGroups(gameWindow).filter((group) => {
      if (filter.minLevel !== undefined && (group.level ?? 0) < filter.minLevel) return false
      if (filter.maxLevel !== undefined && (group.level ?? 0) > filter.maxLevel) return false
      if (filter.minSize !== undefined && group.size < filter.minSize) return false
      if (filter.maxSize !== undefined && group.size > filter.maxSize) return false
      return true
    })

    if (filter.nearestFirst === false) return groups

    const from = getCellId(gameWindow)
    if (from === null) return groups

    return [...groups].sort((a, b) => {
      const da = a.cellId === null ? Number.MAX_SAFE_INTEGER : cellDistance(from, a.cellId)
      const db = b.cellId === null ? Number.MAX_SAFE_INTEGER : cellDistance(from, b.cellId)
      return da - db
    })
  }

  const attack = async (
    group: MonsterGroup | number,
    options: AttackOptions = {}
  ): Promise<boolean> => {
    throwIfAborted()

    const groupId = typeof group === 'number' ? group : group.id
    const groupCell = typeof group === 'number' ? null : group.cellId
    const report = (message: string) => ctx.hooks.onLog('info', message)

    if (options.approach !== false && groupCell !== null) {
      const from = getCellId(gameWindow)

      if (from === null) {
        report('Attack: unknown position, attacking from where we stand')
      } else if (cellDistance(from, groupCell) > 1) {
        // Walking onto the group's own cell never completes — it is occupied.
        // Stand next to it instead.
        const occupied = new Set(
          getMonsterGroups(gameWindow)
            .map((candidate) => candidate.cellId)
            .filter((cellId): cellId is number => cellId !== null)
        )
        const landing = findCellNextTo(gameWindow, groupCell, from, occupied)

        if (landing === null) {
          report(`Attack: no free cell next to the group on cell ${groupCell}`)
        } else {
          report(`Attack: walking to cell ${landing}, next to the group on ${groupCell}`)
          try {
            await moveToCell(landing, { timeout: options.timeout ?? ATTACK_APPROACH_TIMEOUT })
          } catch (err) {
            if (err instanceof ScriptAbortError) throw err
            report(`Attack: could not reach the group (${err instanceof Error ? err.message : String(err)})`)
          }
        }
      }
    }

    const timeout = options.timeout ?? DEFAULT_ATTACK_TIMEOUT
    const started = waitForMessage('GameFightStartingMessage', { timeout })

    const distance = groupCell !== null && getCellId(gameWindow) !== null
      ? cellDistance(getCellId(gameWindow) as number, groupCell)
      : null
    report(
      `Attack: requesting group ${groupId}` +
        (distance !== null ? ` from ${distance} cell(s) away` : '')
    )

    // The game's own flow is: select the group, then press the button it shows.
    // Entry points differ between builds, so each is tried and judged on what
    // it produces — a button appearing, or the fight starting.
    let done = false

    const pressButton = (): boolean => {
      const button = findAttackButton(gameWindow)
      if (!button) return false
      try {
        button.click()
        report('Attack: pressed the attack button')
        return true
      } catch (err) {
        report(`Attack: the button refused the click (${err instanceof Error ? err.message : String(err)})`)
        return false
      }
    }

    if (pressButton()) done = true

    if (!done) {
      const tried: string[] = []

      // A call that does not throw has not necessarily done anything, so each
      // candidate is judged on what follows it, and the search continues.
      for (const owner of attackOwners(gameWindow)) {
        for (const method of TAP_METHODS) {
          if (done) break
          if (!callWithGroup(owner.value, method, groupId)) continue
          tried.push(`${owner.label}.${method}()`)

          for (let attempt = 0; attempt < 3 && !done; attempt++) {
            await wait(150)
            if (pressButton()) done = true
            else if (isInFight(gameWindow)) done = true
          }
        }
        if (done) break
      }

      if (tried.length > 0) report(`Attack: tried ${tried.join(', ')}`)
    }

    // Walking onto the group is how a player starts a fight on some builds: the
    // client takes over on the way and opens its confirmation.
    if (!done && groupCell !== null && options.approach !== false) {
      report(`Attack: walking onto the group cell ${groupCell}`)
      for (const method of MOVE_METHODS) {
        if (callMoveMethod(gameWindow, method, groupCell)) break
      }
      for (let attempt = 0; attempt < 8 && !done; attempt++) {
        await wait(250)
        if (pressButton()) done = true
        else if (isInFight(gameWindow)) done = true
      }
    }

    if (!done) {
      const attempts = requestAttack(gameWindow, groupId)
      report(`Attack: falling back to ${attempts.map((attempt) => attempt.strategy).join(', ')}`)

      // Nothing worked: say what is on screen, so the entry point can be found.
      const labels = visibleLabels(gameWindow)
      report(`Attack: on screen now — ${labels.join(' | ') || 'nothing readable'}`)
    }

    try {
      await started
      return true
    } catch (err) {
      if (err instanceof ScriptAbortError) throw err
      report(`Attack: no fight started within ${timeout}ms`)
      return false
    }
  }

  const broadcastChannels = new Map<string, BroadcastChannel>()
  const channelFor = (channel: string): BroadcastChannel => {
    const existing = broadcastChannels.get(channel)
    if (existing) return existing
    const created = new BroadcastChannel(BROADCAST_PREFIX + channel)
    broadcastChannels.set(channel, created)
    ctx.registerCleanup(() => {
      broadcastChannels.delete(channel)
      try {
        created.close()
      } catch {}
    })
    return created
  }

  return {
    get tabId() {
      return ctx.tabId
    },
    get scriptId() {
      return ctx.script.id
    },
    get runId() {
      return ctx.runId
    },
    get iteration() {
      return ctx.getIteration()
    },

    log: (...args) => ctx.hooks.onLog('info', format(args)),
    warn: (...args) => ctx.hooks.onLog('warn', format(args)),
    error: (...args) => ctx.hooks.onLog('error', format(args)),
    stop: (reason?: string) => {
      throw new ScriptAbortError(reason ? `Stopped: ${reason}` : 'Stopped by script')
    },

    wait,
    waitRandom: (minMs, maxMs) => wait(random(minMs, maxMs)),
    waitUntil,
    waitForMessage,

    character: () => getCharacter(gameWindow),
    map: () => getMapInfo(gameWindow),
    mapId: currentMapId,
    cellId: () => getCellId(gameWindow),
    isInFight: () => isInFight(gameWindow),
    isConnected: () => isConnected(gameWindow),
    isMoving: () => isMoving(gameWindow),

    moveToCell,
    move,
    movePath,
    changeMap,
    travelTo,

    fight,

    closePopups: (patterns) => closeUiPopups(gameWindow, patterns),

    inspect: (pattern) => {
      const lines = describeGameApi(gameWindow, pattern)
      for (const line of lines) ctx.hooks.onLog('info', line)
      return lines
    },

    inspectMap: () => {
      const lines = describeMapSources(gameWindow)
      for (const line of lines) ctx.hooks.onLog('info', line)
      return lines
    },

    monsters,
    attack,

    interactives: () => getInteractiveElements(gameWindow),
    interact,
    gather,

    send: (name, data) => {
      throwIfAborted()
      sendMessage(gameWindow, name, data ?? {})
    },
    on,
    chat: (text, channel = 0) => {
      throwIfAborted()
      sendMessage(gameWindow, 'ChatClientMultiMessage', { content: text, channel })
    },
    invite: (name) => {
      throwIfAborted()
      sendMessage(gameWindow, 'PartyInvitationRequestMessage', { name })
    },
    acceptInvite: (partyId) => {
      throwIfAborted()
      sendMessage(gameWindow, 'PartyAcceptInvitationMessage', { partyId })
    },

    broadcast: (channel, data) => {
      throwIfAborted()
      channelFor(channel).postMessage(data)
    },
    onBroadcast: (channel, handler) => {
      const target = channelFor(channel)
      const listener = (event: MessageEvent) => handler(event.data)
      target.addEventListener('message', listener)
      const dispose = () => target.removeEventListener('message', listener)
      ctx.registerCleanup(dispose)
      return dispose
    },

    random,
    pick: <T,>(items: T[]): T => {
      if (!items.length) throw new Error('api.pick() needs a non-empty array')
      return items[random(0, items.length - 1)]
    },

    raw: {
      window: gameWindow,
      gui: gameWindow.gui,
      isoEngine: gameWindow.isoEngine,
      connectionManager: gameWindow.dofus?.connectionManager
    }
  }
}
