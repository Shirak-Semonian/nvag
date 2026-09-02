/**
 * Db2Bridge — Java-sidecar voor de Db2-provider (F1-9, SAL-22).
 *
 * Draait de IBM DB2 JDBC-driver (jcc.jar, Type 4) en praat met Node via
 * newline-gescheiden JSON over stdin/stdout (NDJSON). Eén regel = één
 * bericht; JSON-strings ontsnappen newlines, dus het protocol is veilig.
 *
 * Starten (Java 11+ single-file source launch):
 *   java -cp <jcc.jar> Db2Bridge.java
 *
 * Protocol:
 *   → {"id":1,"op":"connect","params":{...}}
 *   ← {"id":1,"ok":true,"result":{...}}
 *   ← {"id":1,"ok":false,"error":"..."}
 *   query streamt: events "columns" → "rows" (0..n) → "done" (of "ok":false).
 *
 * De bridge is bewust generiek (JDBC-executor): alle Db2-specifieke
 * catalogus-SQL (SYSCAT.*) zit in de TypeScript-provider, zodat die
 * unittestbaar is en de bridge later ook andere JDBC-databases (Oracle)
 * kan draaien.
 */

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.sql.Blob;
import java.sql.Clob;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public class Db2Bridge {

  /** Open verbindingen per connId (één sidecar kan meerdere sessies bedienen). */
  private static final Map<String, Connection> CONNS = new HashMap<>();

  public static void main(String[] args) throws Exception {
    // Zorg dat de driver expliciet geladen is (jcc registreert zichzelf via
    // ServiceLoader, maar expliciet laden is robuuster).
    try {
      Class.forName("com.ibm.db2.jcc.DB2Driver");
    } catch (ClassNotFoundException e) {
      // DriverManager probeert het alsnog; de fout komt dan bij connect.
    }

    BufferedReader in = new BufferedReader(
        new InputStreamReader(System.in, StandardCharsets.UTF_8));
    PrintWriter out = new PrintWriter(
        new OutputStreamWriter(System.out, StandardCharsets.UTF_8), true);

    String line;
    while ((line = in.readLine()) != null) {
      if (line.trim().isEmpty()) continue;
      try {
        handle(line, out);
      } catch (Throwable t) {
        String msg = t.getMessage() == null ? t.toString() : t.getMessage();
        out.println("{\"id\":0,\"ok\":false,\"error\":" + Json.escape(msg) + "}");
      }
      out.flush();
    }
  }

  private static void handle(String line, PrintWriter out) throws Exception {
    Map<String, Object> req = Json.parseObject(line);
    long id = Json.asLong(req.get("id"), 0L);
    String op = Json.asString(req.get("op"), "");
    Map<String, Object> params = Json.asObject(req.get("params"));

    try {
      switch (op) {
        case "connect": {
          String url = Json.asString(params.get("url"), "");
          String user = Json.asString(params.get("user"), "");
          String password = Json.asString(params.get("password"), "");
          int timeout = (int) Json.asLong(params.get("connectionTimeoutMs"), 15000L);
          DriverManager.setLoginTimeout(Math.max(1, timeout / 1000));
          Connection conn = DriverManager.getConnection(url, user, password);
          String connId = UUID.randomUUID().toString();
          CONNS.put(connId, conn);
          Map<String, Object> r = new LinkedHashMap<>();
          r.put("connId", connId);
          respondOk(out, id, r);
          break;
        }
        case "close": {
          String connId = Json.asString(params.get("connId"), "");
          Connection conn = CONNS.remove(connId);
          if (conn != null) {
            try {
              conn.close();
            } catch (SQLException ignored) {
              // al gesloten
            }
          }
          Map<String, Object> r = new LinkedHashMap<>();
          r.put("closed", true);
          respondOk(out, id, r);
          break;
        }
        case "serverInfo": {
          Connection conn = requireConn(params);
          DatabaseMetaData md = conn.getMetaData();
          Map<String, Object> r = new LinkedHashMap<>();
          r.put("dbmsName", safe(md.getDatabaseProductName()));
          r.put("dbmsVersion", safe(md.getDatabaseProductVersion()));
          r.put("database", safe(conn.getCatalog()));
          r.put("user", safe(md.getUserName()));
          respondOk(out, id, r);
          break;
        }
        case "query": {
          Connection conn = requireConn(params);
          String sql = Json.asString(params.get("sql"), "");
          long maxRows = Json.asLong(params.get("maxRows"), 0L);
          runQuery(conn, sql, maxRows, out, id);
          break;
        }
        default:
          respondError(out, id, "onbekende op: " + op);
      }
    } catch (Exception e) {
      respondError(out, id, e.getMessage() == null ? e.toString() : e.getMessage());
    }
  }

  private static Connection requireConn(Map<String, Object> params) throws SQLException {
    String connId = Json.asString(params.get("connId"), "");
    Connection conn = CONNS.get(connId);
    if (conn == null) throw new SQLException("onbekende connId: " + connId);
    return conn;
  }

  /** Voer één statement uit; SELECT streamt als events, anders done met rowcount. */
  private static void runQuery(Connection conn, String sql, long maxRows,
                               PrintWriter out, long id) throws SQLException {
    long start = System.currentTimeMillis();
    try (Statement stmt = conn.createStatement()) {
      if (maxRows > 0) {
        try {
          stmt.setMaxRows((int) Math.min(maxRows, Integer.MAX_VALUE));
        } catch (SQLException ignored) {
          // maxRows is een veiligheidsnet; FETCH FIRST doet het echte werk
        }
        // jcc weigert een fetch-size groter dan maxRows ([jcc][10137],
        // SQLSTATE=42815) — bij een kleine cap de fetch-size gelijk aan
        // maxRows houden (min(200, maxRows)).
        try {
          stmt.setFetchSize((int) Math.min(200L, Math.max(1L, maxRows)));
        } catch (SQLException ignored) {
          // fetch-size is een optimalisatie; zonder werkt de query ook
        }
      } else {
        stmt.setFetchSize(200);
      }
      boolean hasResultSet = stmt.execute(sql);
      if (hasResultSet) {
        try (ResultSet rs = stmt.getResultSet()) {
          ResultSetMetaData md = rs.getMetaData();
          int ncols = md.getColumnCount();
          List<Object> cols = new ArrayList<>(ncols);
          for (int i = 1; i <= ncols; i++) {
            Map<String, Object> c = new LinkedHashMap<>();
            c.put("name", md.getColumnLabel(i));
            cols.add(c);
          }
          sendEvent(out, id, "columns", cols);

          int rowCount = 0;
          List<Object> batch = new ArrayList<>();
          while (rs.next()) {
            List<Object> row = new ArrayList<>(ncols);
            for (int i = 1; i <= ncols; i++) {
              row.add(toJson(rs.getObject(i)));
            }
            batch.add(row);
            rowCount++;
            if (batch.size() >= 500) {
              sendEvent(out, id, "rows", batch);
              batch = new ArrayList<>();
            }
          }
          if (!batch.isEmpty()) sendEvent(out, id, "rows", batch);
          sendDone(out, id, rowCount, System.currentTimeMillis() - start);
        }
      } else {
        int n = stmt.getUpdateCount();
        sendDone(out, id, Math.max(n, 0), System.currentTimeMillis() - start);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Response-helpers
  // -------------------------------------------------------------------------

  private static void respondOk(PrintWriter out, long id, Object result) {
    out.println("{\"id\":" + id + ",\"ok\":true,\"result\":" + Json.write(result) + "}");
  }

  private static void respondError(PrintWriter out, long id, String message) {
    out.println("{\"id\":" + id + ",\"ok\":false,\"error\":" + Json.escape(message) + "}");
  }

  /** Events dragen hun data direct als `columns` resp. `rows` (zie protocol-doc). */
  private static void sendEvent(PrintWriter out, long id, String event, Object payload) {
    out.println("{\"id\":" + id + ",\"ok\":true,\"event\":\"" + event
        + "\",\"" + event + "\":" + Json.write(payload) + "}");
  }

  private static void sendDone(PrintWriter out, long id, long rowCount, long durationMs) {
    out.println("{\"id\":" + id + ",\"ok\":true,\"event\":\"done\",\"rowCount\":"
        + rowCount + ",\"durationMs\":" + durationMs + "}");
  }

  // -------------------------------------------------------------------------
  // Waardeconversie JDBC → JSON
  // -------------------------------------------------------------------------

  private static String safe(String v) {
    return v == null ? "" : v;
  }

  /** Binaire waarden worden {"$bin":"<base64>"} — de provider maakt er Uint8Array van. */
  private static Object toJson(Object v) {
    if (v == null) return null;
    if (v instanceof Boolean || v instanceof String) return v;
    if (v instanceof Integer || v instanceof Long || v instanceof Short || v instanceof Byte) {
      return ((Number) v).longValue();
    }
    if (v instanceof Float || v instanceof Double) return ((Number) v).doubleValue();
    if (v instanceof BigDecimal || v instanceof BigInteger) return ((Number) v).doubleValue();
    if (v instanceof byte[]) {
      Map<String, Object> m = new LinkedHashMap<>();
      m.put("$bin", Base64.getEncoder().encodeToString((byte[]) v));
      return m;
    }
    if (v instanceof Blob) {
      try {
        Blob b = (Blob) v;
        byte[] data = b.getBytes(1, (int) b.length());
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("$bin", Base64.getEncoder().encodeToString(data));
        return m;
      } catch (SQLException e) {
        return null;
      }
    }
    if (v instanceof Clob) {
      try {
        Clob c = (Clob) v;
        return c.getSubString(1, (int) c.length());
      } catch (SQLException e) {
        return null;
      }
    }
    // java.sql.Date/Time/Timestamp en overige typen → toString()
    return v.toString();
  }

  // -------------------------------------------------------------------------
  // Minimale JSON-ondersteuning (parse + write) — bewust klein en strikt.
  // Requests zijn vlak (string/number params); responses bevatten geneste
  // structuren die alleen geschreven hoeven te worden.
  // -------------------------------------------------------------------------

  static final class Json {
    static String escape(String s) {
      StringBuilder sb = new StringBuilder(s.length() + 16);
      sb.append('"');
      for (int i = 0; i < s.length(); i++) {
        char c = s.charAt(i);
        switch (c) {
          case '"': sb.append("\\\""); break;
          case '\\': sb.append("\\\\"); break;
          case '\n': sb.append("\\n"); break;
          case '\r': sb.append("\\r"); break;
          case '\t': sb.append("\\t"); break;
          case '\b': sb.append("\\b"); break;
          case '\f': sb.append("\\f"); break;
          default:
            if (c < 0x20) {
              sb.append(String.format("\\u%04x", (int) c));
            } else {
              sb.append(c);
            }
        }
      }
      sb.append('"');
      return sb.toString();
    }

    static String write(Object v) {
      if (v == null) return "null";
      if (v instanceof String) return escape((String) v);
      if (v instanceof Boolean || v instanceof Number) return v.toString();
      if (v instanceof Map) {
        StringBuilder sb = new StringBuilder();
        sb.append('{');
        boolean first = true;
        for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
          if (!first) sb.append(',');
          first = false;
          sb.append(escape(String.valueOf(e.getKey()))).append(':').append(write(e.getValue()));
        }
        return sb.append('}').toString();
      }
      if (v instanceof List) {
        StringBuilder sb = new StringBuilder();
        sb.append('[');
        boolean first = true;
        for (Object item : (List<?>) v) {
          if (!first) sb.append(',');
          first = false;
          sb.append(write(item));
        }
        return sb.append(']').toString();
      }
      return escape(String.valueOf(v));
    }

    static Map<String, Object> parseObject(String text) {
      Parser p = new Parser(text);
      Object v = p.parseValue();
      if (!(v instanceof Map)) throw new IllegalArgumentException("verwacht JSON-object");
      return asObject(v);
    }

    static String asString(Object v, String def) {
      return v instanceof String ? (String) v : def;
    }

    static long asLong(Object v, long def) {
      if (v instanceof Number) return ((Number) v).longValue();
      return def;
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> asObject(Object v) {
      return v instanceof Map ? (Map<String, Object>) v : new LinkedHashMap<>();
    }

    /** Recursive-descent parser voor objecten/arrays/strings/numbers/bools/null. */
    static final class Parser {
      private final String s;
      private int i;

      Parser(String s) {
        this.s = s;
      }

      Object parseValue() {
        skipWs();
        if (i >= s.length()) throw new IllegalArgumentException("lege JSON");
        char c = s.charAt(i);
        switch (c) {
          case '{': return parseObject();
          case '[': return parseArray();
          case '"': return parseString();
          case 't': expect("true"); return Boolean.TRUE;
          case 'f': expect("false"); return Boolean.FALSE;
          case 'n': expect("null"); return null;
          default: return parseNumber();
        }
      }

      private void skipWs() {
        while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
      }

      private void expect(String word) {
        if (!s.startsWith(word, i)) throw new IllegalArgumentException("verwacht " + word);
        i += word.length();
      }

      private Map<String, Object> parseObject() {
        Map<String, Object> map = new LinkedHashMap<>();
        i++; // {
        skipWs();
        if (i < s.length() && s.charAt(i) == '}') { i++; return map; }
        while (true) {
          skipWs();
          String key = parseString();
          skipWs();
          if (i >= s.length() || s.charAt(i) != ':') throw new IllegalArgumentException("verwacht ':'");
          i++;
          map.put(key, parseValue());
          skipWs();
          if (i >= s.length()) throw new IllegalArgumentException("verwacht ',' of '}'");
          char c = s.charAt(i);
          if (c == '}') { i++; return map; }
          if (c == ',') { i++; continue; }
          throw new IllegalArgumentException("verwacht ',' of '}'");
        }
      }

      private List<Object> parseArray() {
        List<Object> list = new ArrayList<>();
        i++; // [
        skipWs();
        if (i < s.length() && s.charAt(i) == ']') { i++; return list; }
        while (true) {
          list.add(parseValue());
          skipWs();
          if (i >= s.length()) throw new IllegalArgumentException("verwacht ',' of ']'");
          char c = s.charAt(i);
          if (c == ']') { i++; return list; }
          if (c == ',') { i++; continue; }
          throw new IllegalArgumentException("verwacht ',' of ']'");
        }
      }

      private String parseString() {
        if (i >= s.length() || s.charAt(i) != '"') throw new IllegalArgumentException("verwacht string");
        i++;
        StringBuilder sb = new StringBuilder();
        while (i < s.length()) {
          char c = s.charAt(i);
          if (c == '"') { i++; return sb.toString(); }
          if (c == '\\') {
            i++;
            if (i >= s.length()) throw new IllegalArgumentException("ongeldige escape");
            char e = s.charAt(i);
            switch (e) {
              case '"': sb.append('"'); break;
              case '\\': sb.append('\\'); break;
              case '/': sb.append('/'); break;
              case 'n': sb.append('\n'); break;
              case 'r': sb.append('\r'); break;
              case 't': sb.append('\t'); break;
              case 'b': sb.append('\b'); break;
              case 'f': sb.append('\f'); break;
              case 'u':
                if (i + 4 >= s.length()) throw new IllegalArgumentException("ongeldige \\u escape");
                sb.append((char) Integer.parseInt(s.substring(i + 1, i + 5), 16));
                i += 4;
                break;
              default: throw new IllegalArgumentException("ongeldige escape: \\" + e);
            }
            i++;
          } else {
            sb.append(c);
            i++;
          }
        }
        throw new IllegalArgumentException("string niet afgesloten");
      }

      private Object parseNumber() {
        int start = i;
        boolean isDouble = false;
        while (i < s.length()) {
          char c = s.charAt(i);
          if (c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E' || Character.isDigit(c)) {
            if (c == '.' || c == 'e' || c == 'E') isDouble = true;
            i++;
          } else {
            break;
          }
        }
        String num = s.substring(start, i);
        if (num.isEmpty()) throw new IllegalArgumentException("ongeldig getal");
        try {
          if (isDouble) return Double.parseDouble(num);
          long l = Long.parseLong(num);
          return l;
        } catch (NumberFormatException e) {
          try {
            return new BigInteger(num).doubleValue();
          } catch (NumberFormatException e2) {
            throw new IllegalArgumentException("ongeldig getal: " + num);
          }
        }
      }
    }
  }
}
