import type { CSSProperties, ReactNode } from 'react'
import { colors } from '@/theme'

export const ghostBtn: CSSProperties = {
  background: 'none', border: 'none', color: colors.textFaint,
  fontSize: 10, cursor: 'pointer',
}

export function hoverColor(e: React.MouseEvent, color: string) {
  (e.currentTarget as HTMLElement).style.color = color
}

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{
        width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer',
        background: checked ? colors.accent : colors.toggleOff,
        position: 'relative', transition: 'background 0.2s', flexShrink: 0, padding: 0,
      }}
    >
      <div style={{
        position: 'absolute', top: 2, left: checked ? 18 : 2,
        width: 16, height: 16, borderRadius: 8, background: colors.white,
        transition: 'left 0.15s', boxShadow: colors.shadow,
      }} />
    </button>
  )
}

export function Select({ value, onChange, options, width }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; width?: number }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        appearance: 'none', background: `${colors.input} url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23666'/%3E%3C/svg%3E") no-repeat right 10px center`,
        border: `1px solid ${colors.border}`, borderRadius: 6, color: colors.textLight,
        fontSize: 12, padding: '6px 28px 6px 10px', outline: 'none', width: width || 'auto', minWidth: 140,
      }}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

export function TextInput({ value, onChange, placeholder, type }: { value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <input
      type={type || 'text'} value={value} placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{
        background: colors.input, border: `1px solid ${colors.border}`, borderRadius: 6,
        color: colors.textLight, fontSize: 12, padding: '6px 10px', outline: 'none', width: '100%',
      }}
    />
  )
}

export function Row({ label, desc, children }: { label: string; desc?: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', minHeight: 36 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: colors.textSecondary, lineHeight: 1.3 }}>{label}</div>
        {desc && <div style={{ fontSize: 11, color: colors.textDesc, marginTop: 1, lineHeight: 1.2 }}>{desc}</div>}
      </div>
      <div style={{ marginLeft: 16, flexShrink: 0 }}>{children}</div>
    </div>
  )
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 2 }}>
      <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.accent, padding: '10px 0 3px', opacity: 0.7 }}>{title}</div>
      <div>{children}</div>
    </div>
  )
}
