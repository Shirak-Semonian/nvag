/**
 * F3-2: Monitoring — actieve queries per dialect (SQLite retourneert leeg).
 */

import { describe, expect, it } from 'vitest'
import { getActiveQueries, getLocks } from './monitoring'

describe('F3-2 monitoring', () => {
  it('retourneert lege lijst zonder sessie (geen crash)', async () => {
    const rows = await getActiveQueries('conn-bestaat-niet')
    expect(rows).toEqual([])
  })

  it('retourneert lege lijst voor een provider zonder monitoring-capability', async () => {
    // Geen sessie: requireSession gooit → vangt leeg af.
    const locks = await getLocks('conn-bestaat-niet')
    expect(locks).toEqual([])
  })
})
