import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Eraser, Plus, Search, X } from 'lucide-react'
import { Row, Section, Select, TextInput, Toggle, ghostBtn, hoverColor } from '@/components/form'
import { useSettingsStore } from '@/stores/settingsStore'
import { useGameTabStore } from '@/stores/gameTabStore'
import { useCombatStore } from '@/stores/combatStore'
import { getSpells, isFightStarted, type SpellInfo } from '@/scripts/fight-bridge'
import { colors } from '@/theme'
import { COMBAT_TARGET_LABELS } from '@dofemu/shared'
import type { CombatTargetStrategy } from '@dofemu/shared'

const TARGET_OPTIONS = (Object.keys(COMBAT_TARGET_LABELS) as CombatTargetStrategy[]).map((value) => ({
  value,
  label: COMBAT_TARGET_LABELS[value]
}))

function activeGameWindow() {
  const activeTabId = useGameTabStore.getState().activeTabId
  if (!activeTabId) return undefined
  return window.$gameWindows?.find((gameWindow) => gameWindow.$game_id === activeTabId)
}

function iconBtn(disabled = false): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 24, height: 24, borderRadius: 5, border: 'none',
    background: colors.surfaceHover, color: disabled ? colors.textDisabled : colors.textMuted,
    cursor: disabled ? 'default' : 'pointer'
  }
}

function ComboEditor() {
  const { combat, addComboSpell, removeComboSpell, moveComboSpell } = useSettingsStore()
  const [detected, setDetected] = useState<SpellInfo[] | null>(null)
  const [manualId, setManualId] = useState('')
  const [manualName, setManualName] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  const detect = () => {
    const gameWindow = activeGameWindow()
    if (!gameWindow) {
      setNotice('No connected tab — open the game first')
      return
    }
    const spells = getSpells(gameWindow)
    setDetected(spells)
    setNotice(
      spells.length > 0
        ? `Found ${spells.length} spell(s) on the active character`
        : 'Could not read the spell list on this build — add spell ids manually'
    )
  }

  const addManual = () => {
    const id = parseInt(manualId, 10)
    if (!Number.isFinite(id) || id <= 0) {
      setNotice('Enter a numeric spell id')
      return
    }
    addComboSpell({ id, name: manualName.trim() || `Spell ${id}` })
    setManualId('')
    setManualName('')
  }

  return (
    <Section title="Spell combo">
      <div style={{ fontSize: 11, color: colors.textDesc, lineHeight: 1.5, padding: '2px 0 8px' }}>
        Cast in this order on every turn, then the turn is passed.
      </div>

      {combat.combo.map((spell, index) => (
        <div
          key={`${spell.id}-${index}`}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', marginBottom: 4,
            background: colors.surface, border: `1px solid ${colors.borderSubtle}`, borderRadius: 6
          }}
        >
          <span style={{ fontSize: 10, color: colors.accentText, fontFamily: 'monospace', width: 16 }}>
            {index + 1}
          </span>
          <span style={{ fontSize: 12, color: colors.textSecondary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {spell.name}
          </span>
          <span style={{ fontSize: 10, color: colors.textFaint, fontFamily: 'monospace' }}>#{spell.id}</span>
          <button onClick={() => moveComboSpell(index, -1)} disabled={index === 0} style={iconBtn(index === 0)}>
            <ArrowUp size={11} />
          </button>
          <button
            onClick={() => moveComboSpell(index, 1)}
            disabled={index === combat.combo.length - 1}
            style={iconBtn(index === combat.combo.length - 1)}
          >
            <ArrowDown size={11} />
          </button>
          <button onClick={() => removeComboSpell(index)} style={iconBtn()}>
            <X size={11} />
          </button>
        </div>
      ))}

      {combat.combo.length === 0 && (
        <div style={{ color: colors.textDisabled, fontSize: 12, padding: 12, textAlign: 'center' }}>
          No spell yet — detect them or add an id below.
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '10px 0 6px' }}>
        <button
          onClick={detect}
          style={{
            display: 'flex', alignItems: 'center', gap: 5, background: colors.surfaceHover,
            border: 'none', borderRadius: 6, color: colors.textMuted, fontSize: 11,
            padding: '6px 12px', cursor: 'pointer'
          }}
        >
          <Search size={11} /> Detect spells
        </button>
        {detected && detected.length > 0 && (
          <Select
            value=""
            onChange={(value) => {
              const spell = detected.find((candidate) => String(candidate.id) === value)
              if (spell) addComboSpell({ id: spell.id, name: spell.name ?? `Spell ${spell.id}` })
            }}
            options={[
              { value: '', label: 'Add a detected spell...' },
              ...detected.map((spell) => ({
                value: String(spell.id),
                label: spell.name ? `${spell.name} (#${spell.id})` : `Spell #${spell.id}`
              }))
            ]}
            width={210}
          />
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr auto', gap: 6 }}>
        <TextInput value={manualId} onChange={setManualId} placeholder="Spell id" type="number" />
        <TextInput value={manualName} onChange={setManualName} placeholder="Name (optional)" />
        <button
          onClick={addManual}
          style={{ background: colors.accent, border: 'none', borderRadius: 6, color: colors.white, fontSize: 12, padding: '0 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
        >
          <Plus size={11} /> Add
        </button>
      </div>

      {notice && <div style={{ fontSize: 11, color: colors.accentText, paddingTop: 8 }}>{notice}</div>}
    </Section>
  )
}

function CombatLog() {
  const { logs, clearLogs } = useCombatStore()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [logs.length])

  return (
    <Section title="Activity">
      <div style={{ display: 'flex', justifyContent: 'flex-end', paddingBottom: 4 }}>
        <button
          onClick={clearLogs}
          style={{ ...ghostBtn, display: 'flex', alignItems: 'center', gap: 4 }}
          onMouseEnter={(e) => hoverColor(e, colors.hoverLight)}
          onMouseLeave={(e) => hoverColor(e, colors.textFaint)}
        >
          <Eraser size={10} /> Clear
        </button>
      </div>
      <div
        ref={ref}
        style={{
          height: 130, overflow: 'auto', background: colors.input,
          border: `1px solid ${colors.borderSubtle}`, borderRadius: 6, padding: 8,
          fontFamily: 'monospace', fontSize: 11, lineHeight: 1.5, color: colors.textMuted
        }}
      >
        {logs.length === 0 && <div style={{ color: colors.textDisabled }}>Nothing yet.</div>}
        {logs.map((entry) => (
          <div key={entry.id}>
            <span style={{ color: colors.textDisabled }}>
              {new Date(entry.timestamp).toLocaleTimeString()}{' '}
            </span>
            {entry.message}
          </div>
        ))}
      </div>
    </Section>
  )
}

export function CombatScreen() {
  const { combat, setCombatSettings, toggleCombatAi } = useSettingsStore()
  const [fighting, setFighting] = useState(false)

  useEffect(() => {
    const timer = setInterval(() => {
      const gameWindow = activeGameWindow()
      setFighting(gameWindow ? isFightStarted(gameWindow) : false)
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <>
      <Section title="Combat AI">
        <Row label="Enable" desc="Play every turn automatically on all connected tabs">
          <Toggle checked={combat.enabled} onChange={toggleCombatAi} />
        </Row>
        <Row label="Status" desc="Active tab">
          <span style={{ fontSize: 11, fontFamily: 'monospace', color: fighting ? '#4ade80' : colors.textFaint }}>
            {fighting ? 'in fight' : 'out of fight'}
          </span>
        </Row>
        <Row label="Target" desc="Which enemy the combo is cast on">
          <Select
            value={combat.targetStrategy}
            onChange={(value) => setCombatSettings({ targetStrategy: value as CombatTargetStrategy })}
            options={TARGET_OPTIONS}
          />
        </Row>
        <Row label="Ready up automatically" desc="Send ready when a fight starts">
          <Toggle checked={combat.autoReady} onChange={(v) => setCombatSettings({ autoReady: v })} />
        </Row>
        <Row label="Close end screens" desc="Dismiss the fight results and level-up windows">
          <Toggle
            checked={combat.closeEndScreens}
            onChange={(v) => setCombatSettings({ closeEndScreens: v })}
          />
        </Row>
        <Row label="End turn after the combo">
          <Toggle
            checked={combat.endTurnAfterCombo}
            onChange={(v) => setCombatSettings({ endTurnAfterCombo: v })}
          />
        </Row>
        <Row label="Delays (ms)" desc="Before the first cast / between casts">
          <div style={{ display: 'flex', gap: 6, width: 180 }}>
            <TextInput
              type="number"
              value={String(combat.turnStartDelayMs)}
              onChange={(v) => setCombatSettings({ turnStartDelayMs: Math.max(0, parseInt(v, 10) || 0) })}
            />
            <TextInput
              type="number"
              value={String(combat.castDelayMs)}
              onChange={(v) => setCombatSettings({ castDelayMs: Math.max(0, parseInt(v, 10) || 0) })}
            />
          </div>
        </Row>
      </Section>

      <ComboEditor />
      <CombatLog />

      <div style={{ fontSize: 10, color: colors.textDesc, lineHeight: 1.5, padding: '8px 0 4px' }}>
        The combo is cast as-is every turn: no line of sight, range or action-point check is done
        yet, so a cast the server refuses is simply skipped. Check your server rules before
        automating fights.
      </div>
    </>
  )
}
