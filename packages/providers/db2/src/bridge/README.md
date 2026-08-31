# Db2 via JDBC-bridge (F1-9, ADR-005)

De Db2-provider gebruikt geen native `ibm_db`-module (die vereist de IBM Data
Server Driver + een native rebuild bij elke Electron-update), maar een kleine
**Java-sidecar** die de IBM DB2 JDBC-driver (`jcc.jar`, Type 4) draait —
dezelfde aanpak als DBeaver. Node en Java wisselen NDJSON uit over
stdin/stdout; de `DatabaseProvider`-interface blijft identiek, de core merkt
niets van de bridge.

```
┌──────────────┐   NDJSON (stdin/stdout)   ┌──────────────────────────────┐
│  provider    │ ────────────────────────▶ │  Db2Bridge.java (Java 11+)   │
│  (Node)      │ ◀──────────────────────── │  + jcc.jar (IBM JDBC-driver) │
└──────────────┘                           └──────────────┬───────────────┘
                                                          │ JDBC (TCP 50000)
                                                   ┌──────▼──────┐
                                                   │  Db2 LUW    │
                                                   └─────────────┘
```

## Vereisten

1. **Java 11+** — op Arch/Omarchy: `sudo pacman -S jre-openjdk`
   (alternatief: `NVAG_DB2_JAVA=/pad/naar/java`).
2. **IBM DB2 JDBC-driver (`jcc.jar`)** — de provider zoekt op:
   - `NVAG_DB2_JCC_JAR` (expliciet pad), of
   - `~/.nvag/db2jcc/jcc.jar` of `~/.nvag/db2jcc/db2jcc4.jar`, of
   - `/opt/ibm/db2/V11.5/java/jcc.jar` (aanwezig in een lokale Db2-installatie).

### jcc.jar verkrijgen (zonder Db2-installatie)

De driver zit in de Db2 Docker-image (voor de lokale testomgeving):

```bash
mkdir -p ~/.nvag/db2jcc
docker run --rm --entrypoint cat ibmcom/db2:11.5.9.0 \
  /opt/ibm/db2/V11.5/java/jcc.jar > ~/.nvag/db2jcc/jcc.jar
```

Of via Maven Central (zelfde jar, publiek artefact):

```bash
curl -L -o ~/.nvag/db2jcc/jcc.jar \
  https://repo1.maven.org/maven2/com/ibm/db2/jcc/11.5.9.0/jcc-11.5.9.0.jar
```

## De bridge handmatig testen

```bash
echo '{"id":1,"op":"connect","params":{"url":"jdbc:db2://localhost:50000/nvagdb","user":"db2inst1","password":"test-password","connectionTimeoutMs":5000}}' \
  | java -cp ~/.nvag/db2jcc/jcc.jar src/bridge/Db2Bridge.java
```

Verwacht antwoord: `{"id":1,"ok":true,"result":{"connId":"..."}}`.

## Configuratie-variabelen

| Variabele             | Betekenis                                         |
|-----------------------|---------------------------------------------------|
| `NVAG_DB2_JAVA`       | Java-binary (default `java`)                       |
| `NVAG_DB2_JCC_JAR`    | Pad naar `jcc.jar` (default: zoeklocaties hierboven) |
| `NVAG_DB2_JCC_DIR`    | Map waarin `jcc.jar` staat                         |
| `NVAG_DB2_BRIDGE_CMD` | Hele bridge-command override (voor tests, bijv. een fake-bridge) |

## Beperkingen (v1)

- **Eén statement per `executeQuery`** (contract-beleid, zelfde als de
  sqlserver-provider); multi-statement wordt geweigerd.
- **`listDatabases`** retourneert alleen de huidige database: DB2 LUW heeft
  geen cross-database-catalogus (elke verbinding is aan één database
  gebonden).
- **Error-positie** is best-effort (SQLERRMC-token terugzoeken in de SQL);
  de contracttest slaat de positie-controle over tot de parsing tegen een
  live server gevalideerd is.
- **Rijtelling** in tabelmetadata is de optimizer-schatting (`SYSCAT.TABLES.NUMROWS`),
  geen exacte `COUNT(*)`.
- Binaire cellen (BLOB) komen als `Uint8Array` binnen (via base64 over de
  bridge); grote `BIGINT`/`DECIMAL`-waarden worden als JSON-number verstuurd
  (binnen IEEE-double-precisie).
