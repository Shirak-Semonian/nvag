/**
 * Recente query's — lichtgewicht lokale lijst (localStorage) van
 * uitgevoerde queries. De zware doorzoekbare SQL-history (F1-6) komt
 * later in main process (SQLite); dit dekt de editor-dropdown.
 */

export interface RecentQueryEntry {
  sql: string
  connectionId: string | null
  at: number
}

const STORAGE_KEY = 'nvag.recentQueries.v1'
const MAX_RECENT = 20

export function loadRecentQueries(): RecentQueryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (e): e is RecentQueryEntry =>
          typeof e === 'object' && e !== null && typeof (e as RecentQueryEntry).sql === 'string'
      )
      .slice(0, MAX_RECENT)
  } catch {
    // localStorage kan ontbreken in tests/private mode — dan gewoon leeg.
    return []
  }
}

export function persistRecentQueries(entries: RecentQueryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_RECENT)))
  } catch {
    // Niet-fataal: de lijst werkt dan alleen in-memory.
  }
}
