/**
 * F4-1: BACKUP/RESTORE DATABASE — dialect-correcte SQL-generatie.
 */

import { describe, expect, it } from 'vitest'
import { buildBackupDatabase, buildRestoreDatabase } from '../src/index'

describe('buildBackupDatabase (F4-1)', () => {
  it('tsql: BACKUP DATABASE met geciteerde database en DISK-path', () => {
    expect(buildBackupDatabase('tsql', 'SalesDB', '/tmp/sales.bak')).toBe(
      "BACKUP DATABASE [SalesDB] TO DISK = '/tmp/sales.bak';"
    )
  })

  it('db2: BACKUP DB met geciteerde database en path', () => {
    expect(buildBackupDatabase('db2', 'NVAGDB', '/tmp/nvag.bk')).toBe(
      "BACKUP DB \"NVAGDB\" TO '/tmp/nvag.bk';"
    )
  })

  it('sqlite/postgres/mysql: geen SQL (bestandskopie in de provider)', () => {
    expect(buildBackupDatabase('sqlite', 'main', '/tmp/x.db')).toBe('')
    expect(buildBackupDatabase('postgres', 'db', '/tmp/x')).toBe('')
    expect(buildBackupDatabase('mysql', 'db', '/tmp/x')).toBe('')
  })

  it('escapes quotes in database-naam en path', () => {
    expect(buildBackupDatabase('tsql', "My'DB", "/tmp/it's.bak")).toBe(
      "BACKUP DATABASE [My'DB] TO DISK = '/tmp/it''s.bak';"
    )
  })
})

describe('buildRestoreDatabase (F4-1)', () => {
  it('tsql: RESTORE DATABASE met WITH REPLACE', () => {
    expect(buildRestoreDatabase('tsql', 'SalesDB', '/tmp/sales.bak')).toBe(
      "RESTORE DATABASE [SalesDB] FROM DISK = '/tmp/sales.bak' WITH REPLACE;"
    )
  })

  it('db2: RESTORE DB met REPLACE EXISTING', () => {
    expect(buildRestoreDatabase('db2', 'NVAGDB', '/tmp/nvag.bk')).toBe(
      "RESTORE DB \"NVAGDB\" FROM '/tmp/nvag.bk' REPLACE EXISTING;"
    )
  })

  it('sqlite/postgres/mysql: geen SQL', () => {
    expect(buildRestoreDatabase('sqlite', 'main', '/tmp/x.db')).toBe('')
    expect(buildRestoreDatabase('postgres', 'db', '/tmp/x')).toBe('')
    expect(buildRestoreDatabase('mysql', 'db', '/tmp/x')).toBe('')
  })
})
