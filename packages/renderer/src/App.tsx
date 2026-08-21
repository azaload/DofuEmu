import { useEffect, useState, createContext, useContext } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { X } from 'lucide-react'
import { SetupScreen } from '@/screens/SetupScreen'
import { GameScreen } from '@/screens/GameScreen'
import { SettingsScreen, type SettingsTabId } from '@/screens/SettingsScreen'
import { colors } from '@/theme'

interface SettingsContextValue {
  settingsOpen: boolean
  setSettingsOpen: (v: boolean) => void
  settingsTab: SettingsTabId
  setSettingsTab: (tab: SettingsTabId) => void
  openSettings: (tab?: SettingsTabId) => void
}

const SettingsContext = createContext<SettingsContextValue>({
  settingsOpen: false,
  setSettingsOpen: () => {},
  settingsTab: 'General',
  setSettingsTab: () => {},
  openSettings: () => {}
})

export const useSettings = () => useContext(SettingsContext)

function SettingsOverlay() {
  const { settingsOpen, setSettingsOpen, settingsTab, setSettingsTab } = useSettings()
  if (!settingsOpen) return null

  const wide = settingsTab === 'Scripts'

  return (
    <div
      style={{
        position: 'fixed', top: 32, left: 0, right: 0, bottom: 0, zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: colors.modalOverlay, backdropFilter: 'blur(4px)'
      }}
      onClick={(e) => { if (e.target === e.currentTarget) setSettingsOpen(false) }}
    >
      <div
        style={{
          width: wide ? 880 : 460, maxWidth: '94vw', maxHeight: wide ? '88vh' : '80vh',
          background: colors.bg, border: `1px solid ${colors.brandBorderFaint}`,
          borderRadius: 10, overflow: 'hidden', boxShadow: colors.modalShadow,
          display: 'flex', flexDirection: 'column'
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px 8px',
        }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: colors.text, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>Settings</span>
          <button
            onClick={() => setSettingsOpen(false)}
            style={{ background: 'none', border: 'none', color: colors.textFaint, cursor: 'pointer', padding: 4, borderRadius: 4, display: 'flex', alignItems: 'center' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = colors.white; e.currentTarget.style.background = colors.surfaceHover }}
            onMouseLeave={(e) => { e.currentTarget.style.color = colors.textFaint; e.currentTarget.style.background = 'none' }}
          >
            <X size={14} />
          </button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '0 18px 16px' }}>
          <SettingsScreen tab={settingsTab} onTabChange={setSettingsTab} />
        </div>
      </div>
    </div>
  )
}

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>('General')

  useEffect(() => { window.dofemu.appReadyToShow() }, [])

  const openSettings = (tab?: SettingsTabId) => {
    if (tab) setSettingsTab(tab)
    setSettingsOpen(true)
  }

  return (
    <SettingsContext.Provider value={{ settingsOpen, setSettingsOpen, settingsTab, setSettingsTab, openSettings }}>
      <HashRouter>
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', overflow: 'hidden' }}>
          <Routes>
            <Route path="/" element={<Navigate to="/updater" replace />} />
            <Route path="/updater" element={<SetupScreen />} />
            <Route path="/game" element={<GameScreen />} />
          </Routes>
          <SettingsOverlay />
        </div>
      </HashRouter>
    </SettingsContext.Provider>
  )
}
