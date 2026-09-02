import { useEffect, useState } from 'react'
import type { ConnectionConfig, ProviderDescriptor } from '@nvag/contracts'
import { useAppStore } from '../state/store'

const EMPTY: Omit<ConnectionConfig, 'id'> = {
  name: '',
  providerId: 'sqlite',
  environment: 'DEV',
  host: '',
  auth: 'username-password',
  ssl: { mode: 'disable' },
  connectionTimeoutMs: 10000,
  createIfMissing: true,
  group: 'Development'
}

export function ConnectionDialog(): React.JSX.Element | null {
  const show = useAppStore((s) => s.showConnectionDialog)
  const mode = useAppStore((s) => s.connectionDialogMode)
  const editingId = useAppStore((s) => s.editingConnectionId)
  const connections = useAppStore((s) => s.connections)
  const saveConnection = useAppStore((s) => s.saveConnection)
  const openSession = useAppStore((s) => s.openSession)
  const close = useAppStore((s) => s.closeConnectionDialog)

  const editing = connections.find((c) => c.id === editingId)
  const [form, setForm] = useState({ ...EMPTY, id: '' })
  const [password, setPassword] = useState('')
  const [testMsg, setTestMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [providers, setProviders] = useState<ProviderDescriptor[]>([])

  useEffect(() => {
    if (show) {
      void window.nvag.providers.list().then(setProviders).catch(() => setProviders([]))
      if (editing) {
        setForm({ ...editing })
      } else {
        setForm({ ...EMPTY, id: crypto.randomUUID() })
      }
      setPassword('')
      setTestMsg(null)
    }
  }, [show, editing])

  if (!show) return null

  const set = (patch: Partial<ConnectionConfig>): void => setForm((f) => ({ ...f, ...patch }))

  const handleTest = async (): Promise<void> => {
    setBusy(true)
    setTestMsg(null)
    try {
      const result = await window.nvag.connections.test(form, password ? { password } : undefined)
      setTestMsg(result.ok ? `✓ ${result.serverInfo?.providerName} ${result.serverInfo?.serverVersion}` : `✗ ${result.message}`)
    } catch (err) {
      setTestMsg(`✗ ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleSave = async (): Promise<void> => {
    if (!form.name.trim() || !form.host.trim()) return
    setBusy(true)
    try {
      if (mode === 'edit') {
        // SAL-50: bewerken van een opgeslagen verbinding. Config opslaan en
        // een open sessie netjes herbouwen met de nieuwe instellingen; was de
        // verbinding niet open, dan géén sessie forceren (anders dan bij een
        // nieuwe verbinding is er geen directe werkstroom die opent).
        const wasOpen = Boolean(useAppStore.getState().openSessions[form.id])
        await saveConnection(form, password ? { password } : undefined)
        if (wasOpen) {
          await useAppStore.getState().closeSession(form.id)
          try {
            // openSaved gebruikt config + vault-secret (ook wanneer de
            // gebruiker geen nieuw wachtwoord intypte).
            await useAppStore.getState().openSavedConnection(form.id)
          } catch (err) {
            setTestMsg(
              `✗ Verbinding opgeslagen, maar opnieuw verbinden mislukt: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
            return
          }
        }
        close()
        return
      }
      const saved = await saveConnection(form, password ? { password } : undefined)
      // Meteen verbinding openen (F0: openen bij opslaan is praktisch)
      await openSession(saved, password ? { password } : undefined)
      close()
    } catch (err) {
      setTestMsg(`✗ ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const envClass = {
    DEV: 'env-dev',
    TEST: 'env-test',
    ACC: 'env-acc',
    PROD: 'env-prod'
  }[form.environment]

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h2>{mode === 'edit' ? 'Verbinding bewerken' : 'Nieuwe verbinding'}</h2>
        <div className="modal-body">
          <label>
            Naam
            <input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Mijn SQLite-db" />
          </label>
          <label>
            Provider
            <select
              value={form.providerId}
              onChange={(e) => {
                const p = providers.find((x) => x.id === e.target.value)
                set({
                  providerId: e.target.value,
                  ...(p && !form.port ? { port: p.defaultPort || undefined } : {})
                })
              }}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName} ({p.dialect})
                </option>
              ))}
            </select>
          </label>
          <label>
            {form.providerId === 'sqlite' ? 'Databasepad (host)' : 'Host'}
            <input value={form.host} onChange={(e) => set({ host: e.target.value })} placeholder={form.providerId === 'sqlite' ? '/pad/naar/test.db' : 'localhost'} />
          </label>
          {form.providerId !== 'sqlite' && (
            <label>
              Poort
              <input
                type="number"
                value={form.port ?? ''}
                onChange={(e) => set({ port: e.target.value ? Number(e.target.value) : undefined })}
                placeholder={String(providers.find((p) => p.id === form.providerId)?.defaultPort ?? '')}
              />
            </label>
          )}
          {form.providerId !== 'sqlite' && (
            <label>
              Database (optioneel)
              <input value={form.database ?? ''} onChange={(e) => set({ database: e.target.value })} placeholder="standaard database/schema" />
            </label>
          )}
          {form.providerId === 'sqlite' && (
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={form.createIfMissing === true}
                onChange={(e) => set({ createIfMissing: e.target.checked })}
              />
              Maak het bestand aan wanneer het niet bestaat
            </label>
          )}
          <label>
            Omgeving
            <select value={form.environment} onChange={(e) => set({ environment: e.target.value as ConnectionConfig['environment'] })}>
              <option value="DEV">DEV</option>
              <option value="TEST">TEST</option>
              <option value="ACC">ACC</option>
              <option value="PROD">PROD</option>
            </select>
          </label>
          <label>
            Groep
            <input value={form.group} onChange={(e) => set({ group: e.target.value })} />
          </label>
          {form.providerId !== 'sqlite' && (
            <>
              <label>
                Gebruikersnaam
                <input value={form.username ?? ''} onChange={(e) => set({ username: e.target.value })} />
              </label>
              <label>
                Wachtwoord
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
            </>
          )}
          <div className={`env-badge ${envClass}`}>{form.environment}</div>
          {testMsg && <div className={`test-msg ${testMsg.startsWith('✓') ? 'ok' : 'err'}`}>{testMsg}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={handleTest} disabled={busy}>Test verbinding</button>
          <button className="primary" onClick={handleSave} disabled={busy}>
            {mode === 'edit' ? 'Opslaan' : 'Opslaan & verbinden'}
          </button>
          <button onClick={close}>Annuleren</button>
        </div>
      </div>
    </div>
  )
}
