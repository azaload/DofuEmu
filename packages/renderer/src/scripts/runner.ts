import type { AutomationScript, ScriptTarget } from '@dofemu/shared'
import { useGameTabStore } from '@/stores/gameTabStore'
import { useScriptStore } from '@/stores/scriptStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useTeamStore } from '@/stores/teamStore'
import type { DofusWindow } from '@/types/dofus-window'
import {
  ScriptRunner,
  findRunner,
  getRunner,
  listRunners,
  registerRunner,
  stopAllRunners,
  unregisterRunner
} from './engine'

export interface StartScriptResult {
  runIds: string[]
  skipped: Array<{ tabId: string; reason: string }>
}

function gameWindowFor(tabId: string): DofusWindow | undefined {
  return window.$gameWindows?.find((gameWindow) => gameWindow.$game_id === tabId)
}

function teamTabIds(role: 'leader' | 'followers'): string[] {
  const team = useTeamStore.getState()
  const activeTeam = team.activeTeamId ? team.getTeam(team.activeTeamId) : undefined
  if (!activeTeam) return []

  const memberIds =
    role === 'leader'
      ? [activeTeam.leaderId]
      : activeTeam.memberIds.filter((id) => id !== activeTeam.leaderId)

  return memberIds
    .map((characterId) => team.getTabForCharacter(characterId))
    .filter((tabId): tabId is string => !!tabId)
}

export function resolveTargetTabs(target: ScriptTarget): string[] {
  const tabs = useGameTabStore.getState()

  switch (target) {
    case 'active-tab':
      return tabs.activeTabId ? [tabs.activeTabId] : []
    case 'all-tabs':
      return tabs.tabs.map((tab) => tab.id)
    case 'team-leader':
      return teamTabIds('leader')
    case 'team-followers':
      return teamTabIds('followers')
    default:
      return []
  }
}

function launch(script: AutomationScript, tabId: string, gameWindow: DofusWindow): string {
  const store = useScriptStore.getState()
  const settings = useSettingsStore.getState().scripts

  const runner = new ScriptRunner({
    script,
    tabId,
    gameWindow,
    settings,
    hooks: {
      onStatus: (run) => useScriptStore.getState().setRun(run),
      onLog: (level, message, run) =>
        useScriptStore.getState().appendLog({
          runId: run.id,
          scriptId: run.scriptId,
          tabId: run.tabId,
          level,
          message,
          timestamp: Date.now()
        })
    }
  })

  registerRunner(runner)
  store.setRun(runner.snapshot())

  void runner.run().finally(() => unregisterRunner(runner))

  return runner.runId
}

export function startScript(
  scriptId: string,
  options: { tabIds?: string[] } = {}
): StartScriptResult {
  const store = useScriptStore.getState()
  const script = store.getScript(scriptId)
  const result: StartScriptResult = { runIds: [], skipped: [] }

  if (!script) return result

  if (!useSettingsStore.getState().scripts.enabled) {
    result.skipped.push({ tabId: '-', reason: 'Automation is disabled in settings' })
    return result
  }

  const tabIds = options.tabIds ?? resolveTargetTabs(script.target)
  if (tabIds.length === 0) {
    result.skipped.push({ tabId: '-', reason: `No tab matches the target "${script.target}"` })
    return result
  }

  for (const tabId of tabIds) {
    if (findRunner(script.id, tabId)) {
      result.skipped.push({ tabId, reason: 'Already running on this tab' })
      continue
    }

    const gameWindow = gameWindowFor(tabId)
    if (!gameWindow) {
      result.skipped.push({ tabId, reason: 'Tab is not connected to the game yet' })
      continue
    }

    result.runIds.push(launch(script, tabId, gameWindow))
  }

  return result
}

export function stopRun(runId: string, reason?: string) {
  getRunner(runId)?.stop(reason)
}

export function stopScript(scriptId: string, reason?: string) {
  for (const runner of listRunners()) {
    if (runner.script.id === scriptId) runner.stop(reason)
  }
}

export function stopAllScripts(reason?: string) {
  stopAllRunners(reason)
}

export function stopScriptsForTab(tabId: string, reason?: string) {
  for (const runner of listRunners()) {
    if (runner.tabId === tabId) runner.stop(reason)
  }
}

export function runningScriptCount(): number {
  return listRunners().length
}
