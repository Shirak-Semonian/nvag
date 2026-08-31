/**
 * F2-4/F3-1: EXPLAIN-parsing en performance-service-tests.
 */

import { describe, expect, it } from 'vitest'
import { parseExplainJson } from './performance'

describe('parseExplainJson (F2-4/F3-1)', () => {
  it('parseert PostgreSQL JSON-EXPLAIN naar een operatorenboom', () => {
    const raw = JSON.stringify([
      {
        Plan: {
          'Node Type': 'Seq Scan',
          'Relation Name': 'users',
          'Actual Rows': 10,
          'Total Cost': 12.5,
          'Plan Width': 8,
          Plans: [
            { 'Node Type': 'Index Scan', 'Relation Name': 'idx', 'Actual Rows': 2, 'Total Cost': 3.1 }
          ]
        }
      }
    ])
    const plan = parseExplainJson(raw, 'postgres')
    expect(plan).toBeDefined()
    expect(plan?.[0]?.operator).toBe('Seq Scan')
    expect(plan?.[0]?.detail).toBe('users')
    expect(plan?.[0]?.rows).toBe(10)
    expect(plan?.[0]?.cost).toBe(12.5)
    expect(plan?.[0]?.children).toHaveLength(1)
    expect(plan?.[0]?.children[0]?.operator).toBe('Index Scan')
  })

  it('parseert MySQL FORMAT=JSON (query_block → table)', () => {
    const raw = JSON.stringify([
      {
        query_block: {
          select_id: 1,
          table: { table_name: 't', access_type: 'ALL', rows: 5 }
        }
      }
    ])
    const plan = parseExplainJson(raw, 'mysql')
    expect(plan).toBeDefined()
    expect(plan?.[0]?.operator).toBe('ALL')
    expect(plan?.[0]?.detail).toBe('t')
    expect(plan?.[0]?.rows).toBe(5)
  })

  it('retourneert undefined bij ongeldige JSON', () => {
    expect(parseExplainJson('geen json', 'postgres')).toBeUndefined()
  })

  it('retourneert undefined zonder Plan-knooppunt', () => {
    expect(parseExplainJson('[{"foo": 1}]', 'postgres')).toBeUndefined()
  })
})
