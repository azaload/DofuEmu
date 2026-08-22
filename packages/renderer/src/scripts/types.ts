import type { AutomationScript, ScriptLogLevel, ScriptSettings } from '@dofemu/shared'
import type { DofusWindow } from '@/types/dofus-window'
import type { CharacterInfo, Direction, MapInfo, MonsterGroup } from './game-bridge'
import type { Fighter, SpellInfo } from './fight-bridge'

export interface WaitUntilOptions {
  timeout?: number
  interval?: number
  message?: string
}

export interface WaitForMessageOptions<T = Record<string, unknown>> {
  timeout?: number
  filter?: (message: T) => boolean
  source?: 'connection' | 'gui'
}

export interface MoveOptions {
  timeout?: number
}

export type TargetStrategy = 'nearest' | 'weakest' | 'strongest' | 'first'

export interface CastOptions {
  timeout?: number
}

export interface MonsterFilter {
  minLevel?: number
  maxLevel?: number
  minSize?: number
  maxSize?: number
  /** Sort candidates by grid distance from the character. Defaults to true. */
  nearestFirst?: boolean
}

export interface AttackOptions {
  /** How long to wait for the fight to start. */
  timeout?: number
  /** Walk onto the group cell before attacking. Defaults to true. */
  approach?: boolean
}

/** Fight helpers, reachable from a script as `api.fight`. */
export interface FightApi {
  isActive: () => boolean
  isMyTurn: () => boolean
  me: () => Fighter | null
  fighters: () => Fighter[]
  enemies: () => Fighter[]
  allies: () => Fighter[]
  spells: () => SpellInfo[]
  target: (strategy?: TargetStrategy) => Fighter | null
  distanceTo: (target: Fighter | number) => number | null
  cast: (spellId: number, target?: Fighter | number, options?: CastOptions) => Promise<boolean>
  endTurn: () => void
  ready: (isReady?: boolean) => void
  waitForTurn: (options?: WaitUntilOptions) => Promise<void>
  waitForTurnEnd: (options?: WaitUntilOptions) => Promise<void>
  waitForFight: (options?: WaitUntilOptions) => Promise<void>
  waitForFightEnd: (options?: WaitUntilOptions) => Promise<void>
}

/** Everything a user script can reach through its `api` argument. */
export interface ScriptApi {
  readonly tabId: string
  readonly scriptId: string
  readonly runId: string
  readonly iteration: number

  log: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  stop: (reason?: string) => never

  wait: (ms: number) => Promise<void>
  waitRandom: (minMs: number, maxMs: number) => Promise<void>
  waitUntil: (predicate: () => boolean | Promise<boolean>, options?: WaitUntilOptions) => Promise<void>
  waitForMessage: <T = Record<string, unknown>>(
    name: string,
    options?: WaitForMessageOptions<T>
  ) => Promise<T>

  character: () => CharacterInfo
  map: () => MapInfo
  mapId: () => number | null
  cellId: () => number | null
  isInFight: () => boolean
  isConnected: () => boolean
  isMoving: () => boolean

  moveToCell: (cellId: number, options?: MoveOptions) => Promise<number>
  move: (direction: Direction | string, options?: MoveOptions) => Promise<number>
  movePath: (path: string | Array<Direction | string>, options?: MoveOptions) => Promise<number>
  changeMap: (mapId: number, options?: MoveOptions) => Promise<number>
  travelTo: (x: number, y: number, options?: MoveOptions & { maxSteps?: number }) => Promise<number>

  fight: FightApi

  closePopups: (patterns?: string[]) => string[]
  /** Logs what the game exposes about the current map, for troubleshooting. */
  inspectMap: () => string[]
  /** Logs the game members matching `pattern`, and the visible button labels. */
  inspect: (pattern?: string) => string[]

  monsters: (filter?: MonsterFilter) => MonsterGroup[]
  attack: (group: MonsterGroup | number, options?: AttackOptions) => Promise<boolean>

  interactives: () => Array<Record<string, unknown>>
  interact: (elementId: number, skillUid?: number) => void
  gather: (options?: MoveOptions) => Promise<boolean>

  send: (name: string, data?: unknown) => void
  on: <T = Record<string, unknown>>(
    name: string,
    handler: (message: T) => void,
    source?: 'connection' | 'gui'
  ) => () => void
  chat: (text: string, channel?: number) => void
  invite: (name: string) => void
  acceptInvite: (partyId: number) => void

  broadcast: (channel: string, data: unknown) => void
  onBroadcast: (channel: string, handler: (data: unknown) => void) => () => void

  random: (min: number, max: number) => number
  pick: <T>(items: T[]) => T

  /** Escape hatch: raw handles on the game window for advanced scripts. */
  readonly raw: {
    window: DofusWindow
    gui: DofusWindow['gui']
    isoEngine: DofusWindow['isoEngine']
    connectionManager: unknown
  }
}

export interface ScriptRuntimeHooks {
  onLog: (level: ScriptLogLevel, message: string) => void
  onIteration?: (iteration: number) => void
}

export interface ScriptRuntimeContext {
  script: AutomationScript
  tabId: string
  runId: string
  gameWindow: DofusWindow
  settings: ScriptSettings
  signal: AbortSignal
  hooks: ScriptRuntimeHooks
  getIteration: () => number
  registerCleanup: (dispose: () => void) => void
}

/** Thrown when a run is cancelled — surfaced as "stopped", never as an error. */
export class ScriptAbortError extends Error {
  constructor(message = 'Script stopped') {
    super(message)
    this.name = 'ScriptAbortError'
  }
}
