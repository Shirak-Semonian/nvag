/**
 * AI Assistant (F3-6, eis 27).
 *
 * Plugin met een eigen API-key van de gebruiker (OpenAI-compatibel
 * chat-completions-endpoint). Context = metadata-cache + schemadefinities
 * van de actieve verbinding. Genereert/verklaart/optimaliseert/converteert
 * SQL — nooit directe writes: het resultaat is altijd een voorstel dat de
 * gebruiker in de editor kan invoegen.
 *
 * De configuratie (baseUrl, model, apiKey) wordt versleuteld in de vault
 * bewaard; de renderer ziet de key nooit terug.
 */

import { registry } from './registry'
import { sessionManager } from './session-manager'
import { vault } from './ipc-bootstrap'

export interface AiConfig {
  baseUrl: string
  model: string
  /** Optioneel: door de gebruiker gezet; wordt in de vault bewaard. */
  apiKey?: string
}

export interface AiConfigInput {
  baseUrl?: string
  model?: string
  apiKey?: string
}

export interface AiRequest {
  connectionId?: string
  /** System-prompt-richting: generate | explain | optimize | convert | free. */
  mode: 'generate' | 'explain' | 'optimize' | 'convert' | 'free'
  /** De SQL of de natuurlijke-taalbeschrijving. */
  input: string
  /** Doeldialect voor convert (bijv. 'postgres'). */
  targetDialect?: string
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_MODEL = 'gpt-4o-mini'

export function getAiConfig(): AiConfig {
  return {
    baseUrl: vault.getSecret('ai', 'baseUrl') ?? DEFAULT_BASE_URL,
    model: vault.getSecret('ai', 'model') ?? DEFAULT_MODEL,
    apiKey: vault.getSecret('ai', 'apiKey') ?? undefined
  }
}

export function saveAiConfig(config: AiConfigInput): void {
  if (config.baseUrl?.trim()) vault.setSecret('ai', 'baseUrl', config.baseUrl.trim())
  if (config.model?.trim()) vault.setSecret('ai', 'model', config.model.trim())
  if (config.apiKey) vault.setSecret('ai', 'apiKey', config.apiKey.trim())
}

/** Bouwt een compacte schemacontext voor de actieve verbinding (eis 27). */
async function buildSchemaContext(connectionId?: string): Promise<string> {
  if (!connectionId) return ''
  const session = sessionManager.getByConnectionId(connectionId)
  if (!session) return ''
  const provider = registry.get(session.providerId)
  try {
    const tables = await provider.listTables(session, session.database)
    const lines: string[] = []
    const dialectName = provider.capabilities.dialect
    lines.push(`Dialect: ${dialectName}`)
    lines.push(`Database: ${session.database}`)
    const schema = provider.capabilities.supportsSchemas ? undefined : 'main'
    for (const table of tables.slice(0, 40)) {
      try {
        const meta = await provider.getTableMetadata(session, session.database, table.schema ?? schema ?? 'main', table.name)
        const cols = meta.columns.map((c) => `${c.name} ${c.dataType}${c.isPrimaryKey ? ' PK' : ''}${c.nullable ? '' : ' NOT NULL'}`)
        lines.push(`TABLE ${table.schema ? table.schema + '.' : ''}${table.name} (${cols.join(', ')})`)
      } catch {
        // metadata niet beschikbaar; overslaan
      }
    }
    return lines.join('\n')
  } catch {
    return ''
  }
}

function systemPrompt(mode: AiRequest['mode'], context: string): string {
  const base = [
    'Je bent een ervaren database-SQL-assistent (Nvag).',
    'Antwoord in het Nederlands, technisch en beknopt.',
    'Geef ALLEEN SQL terug waar gevraagd (geen uitleg eromheen), tenzij de uitleg expliciet gevraagd is.',
    'Nooit directe writes uitvoeren; voorstellen zijn altijd bedoeld om door de gebruiker te worden beoordeeld.',
    'Gebruik de volgende schemacontext als die aanwezig is:',
    '---SCHEMA---',
    context || '(geen context)',
    '---EINDE SCHEMA---'
  ].join('\n')
  switch (mode) {
    case 'generate':
      return `${base}\nOpdracht: genereer SQL op basis van de beschrijving van de gebruiker.`
    case 'explain':
      return `${base}\nOpdracht: verklaar de opgegeven SQL stap voor stap (wat doet elke clausule, eventuele valkuilen).`
    case 'optimize':
      return `${base}\nOpdracht: optimaliseer de opgegeven SQL (prestaties, indexen, leesbaarheid) en geef de verbeterde SQL plus een korte toelichting.`
    case 'convert':
      return `${base}\nOpdracht: converteer de opgegeven SQL naar het gevraagde doeldialect.`
    default:
      return base
  }
}

/** Roept het OpenAI-compatibele chat-endpoint aan. */
export async function aiChat(req: AiRequest): Promise<{ text: string }> {
  const config = getAiConfig()
  if (!config.apiKey) {
    throw new Error('Geen AI API-key geconfigureerd. Stel die in via de AI-tab (Instellingen).')
  }
  const context = await buildSchemaContext(req.connectionId)
  const targetNote = req.targetDialect ? `\nDoeldialect: ${req.targetDialect}` : ''
  const userContent = `${req.input}${targetNote}`

  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt(req.mode, context) },
        { role: 'user', content: userContent }
      ],
      temperature: 0.2
    })
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`AI-fout (${response.status}): ${body.slice(0, 300)}`)
  }
  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const text = data.choices?.[0]?.message?.content?.trim()
  if (!text) throw new Error('AI gaf geen antwoord terug.')
  return { text }
}
