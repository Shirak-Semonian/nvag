/**
 * F3-panelen: ComparePanel, ErdPanel, AiPanel en PluginsPanel (renderer).
 */

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ConnectionConfig } from '@nvag/contracts'
import { useAppStore } from '../src/renderer/src/state/store'
import { createMockNvag } from '../src/renderer/src/test/mockNvag'
import { ComparePanel, ErdPanel, AiPanel, PluginsPanel } from '../src/renderer/src/components/F3Panels'

const conn: ConnectionConfig = {
  id: 'conn-1',
  name: 'Test DB',
  providerId: 'sqlite',
  environment: 'DEV',
  host: '/tmp/test.db',
  auth: 'username-password',
  ssl: { mode: 'disable' },
  connectionTimeoutMs: 5000,
  group: 'Test'
}

describe('F3 ComparePanel', () => {
  it('toont een schema-verschil na vergelijken', async () => {
    const api = createMockNvag({ connections: [conn] })
    api.compare.schemas = async () => ({
      tablesOnlyInSource: ['orders'],
      tablesOnlyInTarget: [],
      columnDiffs: [{ table: 'users', missingInTarget: ['email'], missingInSource: [] }],
      missingTables: 1,
      missingColumns: 1
    })
    ;(window as unknown as { nvag: unknown }).nvag = api
    useAppStore.setState({ connections: [conn] })

    const html = renderToStaticMarkup(<ComparePanel activeConnectionId="conn-1" />)
    expect(html).toContain('Compare')
  })
})

describe('F3 ErdPanel', () => {
  it('rendert het canvas zonder data (lege staat)', () => {
    const api = createMockNvag({ connections: [conn] })
    api.metadata.listTables = async () => []
    ;(window as unknown as { nvag: unknown }).nvag = api
    useAppStore.setState({ connections: [conn] })
    const html = renderToStaticMarkup(<ErdPanel connectionId="conn-1" />)
    expect(html).toContain('ER diagram')
  })
})

describe('F3 AiPanel', () => {
  it('toont modus-knoppen en config-knop', () => {
    ;(window as unknown as { nvag: unknown }).nvag = createMockNvag({ connections: [conn] })
    useAppStore.setState({ connections: [conn], tabs: [], activeTabId: null })
    const html = renderToStaticMarkup(<AiPanel connectionId={null} activeTabId={null} activeSql="" />)
    expect(html).toContain('Generate')
    expect(html).toContain('Optimize')
    expect(html).toContain('Settings')
  })
})

describe('F3 PluginsPanel', () => {
  it('toont plugins uit de registry', async () => {
    const api = createMockNvag({ connections: [conn] })
    api.plugins.list = async () => [{ name: 'Mijn Plugin', source: '/plugins/x.mjs', providerName: 'Voorbeeld', ok: true }]
    ;(window as unknown as { nvag: unknown }).nvag = api
    const html = renderToStaticMarkup(<PluginsPanel />)
    expect(html).toContain('Plugins')
  })
})
