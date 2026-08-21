import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, Square, Copy, Trash2, Plus, Download, Upload, Eraser } from 'lucide-react'
import { Row, Section, Select, TextInput, Toggle, ghostBtn, hoverColor } from '@/components/form'
import { logLevelColor, useScriptStore } from '@/stores/scriptStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { SCRIPT_TEMPLATES, scriptFromTemplate } from '@/scripts/templates'
import { resolveTargetTabs, startScript, stopScript } from '@/scripts/runner'
import { API_REFERENCE } from '@/scripts/reference'
import { colors } from '@/theme'
import type { AutomationScript, ScriptRun, ScriptTarget } from '@dofemu/shared'
import { SCRIPT_TARGET_LABELS } from '@dofemu/shared'

const TARGET_OPTIONS = (Object.keys(SCRIPT_TARGET_LABELS) as ScriptTarget[]).map((value) => ({
  value,
  label: SCRIPT_TARGET_LABELS[value]
}))

const statusColor: Record<ScriptRun['status'], string> = {
  running: '#4ade80',
  stopping: '#d9a441',
  stopped: colors.textMuted,
  done: colors.accentText,
  error: colors.danger
}

const actionBtn = (accent = false): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 5,
  background: accent ? colors.accent : colors.surfaceHover,
  border: 'none', borderRadius: 6, cursor: 'pointer',
  color: accent ? colors.white : colors.textMuted,
  fontSize: 11, padding: '6px 12px'
})

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString()
}

function CodeEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Tab') return
    event.preventDefault()
    const target = event.currentTarget
    const { selectionStart, selectionEnd } = target
    const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`
    onChange(next)
    requestAnimationFrame(() => {
      target.selectionStart = target.selectionEnd = selectionStart + 2
    })
  }

  return (
    <textarea
      value={value}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={handleKeyDown}
      style={{
        width: '100%', minHeight: 260, resize: 'vertical',
        background: colors.input, border: `1px solid ${colors.border}`, borderRadius: 6,
        color: colors.textLight, fontFamily: 'monospace', fontSize: 12, lineHeight: 1.55,
        padding: 10, outline: 'none', tabSize: 2, whiteSpace: 'pre'
      }}
    />
  )
}

function RunnerSettings() {
  const { scripts, setScriptSettings, toggleScripts } = useSettingsStore()

  return (
    <Section title="Runner">
      <Row label="Enable automation" desc="Master switch for every script">
        <Toggle checked={scripts.enabled} onChange={toggleScripts} />
      </Row>
      <Row label="Human-like delays" desc="Random pause after each in-game action">
        <Toggle checked={scripts.humanDelays} onChange={(v) => setScriptSettings({ humanDelays: v })} />
      </Row>
      {scripts.humanDelays && (
        <Row label="Action delay (ms)" desc="Minimum and maximum pause">
          <div style={{ display: 'flex', gap: 6, width: 180 }}>
            <TextInput
              type="number"
              value={String(scripts.minActionDelayMs)}
              onChange={(v) => setScriptSettings({ minActionDelayMs: Math.max(0, parseInt(v, 10) || 0) })}
            />
            <TextInput
              type="number"
              value={String(scripts.maxActionDelayMs)}
              onChange={(v) => setScriptSettings({ maxActionDelayMs: Math.max(0, parseInt(v, 10) || 0) })}
            />
          </div>
        </Row>
      )}
      <Row label="Stop on fight" desc="Abort a script when the character enters a fight">
        <Toggle checked={scripts.stopOnFight} onChange={(v) => setScriptSettings({ stopOnFight: v })} />
      </Row>
      <Row label="Runtime limit (min)" desc="Every run stops after this many minutes">
        <div style={{ width: 90 }}>
          <TextInput
            type="number"
            value={String(scripts.maxRuntimeMinutes)}
            onChange={(v) => setScriptSettings({ maxRuntimeMinutes: Math.max(1, parseInt(v, 10) || 1) })}
          />
        </div>
      </Row>
    </Section>
  )
}

function ScriptEditor({ script }: { script: AutomationScript }) {
  const { updateScript, deleteScript, duplicateScript, runs, logs, clearLogs } = useScriptStore()
  const [feedback, setFeedback] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  const scriptRuns = useMemo(
    () => Object.values(runs).filter((run) => run.scriptId === script.id),
    [runs, script.id]
  )
  const activeRuns = scriptRuns.filter((run) => run.status === 'running' || run.status === 'stopping')
  const scriptLogs = useMemo(
    () => logs.filter((entry) => entry.scriptId === script.id),
    [logs, script.id]
  )

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [scriptLogs.length])

  useEffect(() => {
    if (!feedback) return
    const timer = setTimeout(() => setFeedback(null), 4000)
    return () => clearTimeout(timer)
  }, [feedback])

  const handleRun = () => {
    const result = startScript(script.id)
    if (result.runIds.length > 0) {
      setFeedback(`Started on ${result.runIds.length} tab(s)`)
      return
    }
    setFeedback(result.skipped[0]?.reason ?? 'Nothing to run')
  }

  const targetTabs = resolveTargetTabs(script.target)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <div style={{ flex: 1 }}>
          <TextInput value={script.name} onChange={(v) => updateScript(script.id, { name: v })} placeholder="Script name" />
        </div>
        {activeRuns.length > 0 ? (
          <button onClick={() => stopScript(script.id, 'Stopped from the editor')} style={actionBtn()}>
            <Square size={11} /> Stop ({activeRuns.length})
          </button>
        ) : (
          <button onClick={handleRun} style={actionBtn(true)}>
            <Play size={11} /> Run
          </button>
        )}
        <button onClick={() => duplicateScript(script.id)} style={actionBtn()} title="Duplicate">
          <Copy size={11} />
        </button>
        <button onClick={() => deleteScript(script.id)} style={actionBtn()} title="Delete">
          <Trash2 size={11} />
        </button>
      </div>

      <TextInput
        value={script.description}
        onChange={(v) => updateScript(script.id, { description: v })}
        placeholder="What does this script do?"
      />

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Select
          value={script.target}
          onChange={(v) => updateScript(script.id, { target: v as ScriptTarget })}
          options={TARGET_OPTIONS}
          width={160}
        />
        <span style={{ fontSize: 11, color: colors.textFaint }}>
          {targetTabs.length} tab(s) matched
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <span style={{ fontSize: 12, color: colors.textSecondary }}>Loop</span>
          <Toggle checked={script.loop} onChange={(v) => updateScript(script.id, { loop: v })} />
          {script.loop && (
            <div style={{ width: 90 }}>
              <TextInput
                type="number"
                value={String(script.loopDelayMs)}
                onChange={(v) => updateScript(script.id, { loopDelayMs: Math.max(0, parseInt(v, 10) || 0) })}
                placeholder="Delay ms"
              />
            </div>
          )}
        </div>
      </div>

      <CodeEditor value={script.source} onChange={(v) => updateScript(script.id, { source: v })} />

      {feedback && (
        <div style={{ fontSize: 11, color: colors.accentText }}>{feedback}</div>
      )}

      {scriptRuns.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {scriptRuns.map((run) => (
            <span
              key={run.id}
              style={{
                fontSize: 10, fontFamily: 'monospace', padding: '3px 8px', borderRadius: 999,
                background: colors.surface, color: statusColor[run.status],
                border: `1px solid ${colors.borderSubtle}`
              }}
            >
              {run.tabId.slice(0, 6)} · {run.status} · #{run.iteration}
              {run.error ? ` · ${run.error}` : ''}
            </span>
          ))}
        </div>
      )}

      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0' }}>
          <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.accent, opacity: 0.7 }}>
            Logs
          </span>
          <button
            onClick={() => clearLogs(script.id)}
            style={{ ...ghostBtn, display: 'flex', alignItems: 'center', gap: 4 }}
            onMouseEnter={(e) => hoverColor(e, colors.hoverLight)}
            onMouseLeave={(e) => hoverColor(e, colors.textFaint)}
          >
            <Eraser size={10} /> Clear
          </button>
        </div>
        <div
          ref={logRef}
          style={{
            height: 140, overflow: 'auto', background: colors.input,
            border: `1px solid ${colors.borderSubtle}`, borderRadius: 6,
            padding: 8, fontFamily: 'monospace', fontSize: 11, lineHeight: 1.5
          }}
        >
          {scriptLogs.length === 0 && (
            <div style={{ color: colors.textDisabled }}>No output yet.</div>
          )}
          {scriptLogs.map((entry) => (
            <div key={entry.id} style={{ color: logLevelColor(entry.level) }}>
              <span style={{ color: colors.textDisabled }}>{formatTime(entry.timestamp)} </span>
              <span style={{ color: colors.textDisabled }}>[{entry.tabId.slice(0, 6)}] </span>
              {entry.message}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ApiReference() {
  return (
    <div style={{ fontSize: 11, lineHeight: 1.6, color: colors.textMuted }}>
      {API_REFERENCE.map((group) => (
        <div key={group.title} style={{ marginBottom: 10 }}>
          <div style={{ color: colors.accentText, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>
            {group.title}
          </div>
          {group.entries.map((entry) => (
            <div key={entry.signature} style={{ display: 'flex', gap: 8, padding: '2px 0' }}>
              <code style={{ fontFamily: 'monospace', color: colors.textLight, whiteSpace: 'nowrap' }}>{entry.signature}</code>
              <span style={{ color: colors.textDesc }}>{entry.description}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

export function ScriptsScreen() {
  const { scripts, selectedScriptId, selectScript, createScript, importScripts, exportScripts } = useScriptStore()
  const [showReference, setShowReference] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const selected = scripts.find((script) => script.id === selectedScriptId) ?? scripts[0]

  useEffect(() => {
    if (!selectedScriptId && scripts.length > 0) selectScript(scripts[0].id)
  }, [selectedScriptId, scripts, selectScript])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  const handleTemplate = (templateId: string) => {
    const template = SCRIPT_TEMPLATES.find((candidate) => candidate.id === templateId)
    if (!template) return
    createScript(scriptFromTemplate(template))
  }

  const handleExport = async () => {
    try {
      await navigator.clipboard.writeText(exportScripts())
      setNotice('Scripts copied to the clipboard as JSON')
    } catch {
      setNotice('Could not access the clipboard')
    }
  }

  const handleImportFile = async (file: File) => {
    try {
      const count = importScripts(await file.text())
      setNotice(count > 0 ? `Imported ${count} script(s)` : 'No script found in that file')
    } catch (err) {
      setNotice(`Import failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={() => handleTemplate('blank')} style={actionBtn(true)}>
          <Plus size={11} /> New script
        </button>
        <Select
          value=""
          onChange={handleTemplate}
          options={[
            { value: '', label: 'From template...' },
            ...SCRIPT_TEMPLATES.map((template) => ({ value: template.id, label: template.name }))
          ]}
          width={170}
        />
        <button onClick={() => fileRef.current?.click()} style={actionBtn()}>
          <Upload size={11} /> Import
        </button>
        <button onClick={handleExport} style={actionBtn()}>
          <Download size={11} /> Export
        </button>
        <button
          onClick={() => setShowReference((v) => !v)}
          style={{ ...actionBtn(), marginLeft: 'auto' }}
        >
          {showReference ? 'Hide API' : 'API reference'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void handleImportFile(file)
            e.target.value = ''
          }}
        />
      </div>

      {notice && <div style={{ fontSize: 11, color: colors.accentText }}>{notice}</div>}

      {showReference && <ApiReference />}

      <div style={{ display: 'grid', gridTemplateColumns: '190px 1fr', gap: 12, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 460, overflow: 'auto' }}>
          {scripts.map((script) => {
            const active = selected?.id === script.id
            return (
              <button
                key={script.id}
                onClick={() => selectScript(script.id)}
                style={{
                  textAlign: 'left', padding: '7px 9px', borderRadius: 6, cursor: 'pointer',
                  background: active ? colors.purpleBg : colors.surface,
                  border: `1px solid ${active ? colors.purpleBorder : colors.borderSubtle}`,
                  color: colors.textSecondary
                }}
              >
                <div style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {script.name}
                </div>
                <div style={{ fontSize: 10, color: colors.textFaint }}>
                  {SCRIPT_TARGET_LABELS[script.target]}{script.loop ? ' · loop' : ''}
                </div>
              </button>
            )
          })}
          {scripts.length === 0 && (
            <div style={{ color: colors.textDisabled, fontSize: 12, padding: 12, textAlign: 'center' }}>
              No script yet
            </div>
          )}
        </div>

        {selected ? (
          <ScriptEditor key={selected.id} script={selected} />
        ) : (
          <div style={{ color: colors.textDisabled, fontSize: 12, padding: 24, textAlign: 'center' }}>
            Create a script or pick a template to get started.
          </div>
        )}
      </div>

      <RunnerSettings />

      <div style={{ fontSize: 10, color: colors.textDesc, lineHeight: 1.5, paddingBottom: 4 }}>
        Scripts are plain JavaScript executed by the client with access to the game window. Only run
        scripts you wrote or trust, and check your server rules before automating gameplay.
      </div>
    </div>
  )
}
