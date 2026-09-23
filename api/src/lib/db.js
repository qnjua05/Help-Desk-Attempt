// Azure SQL access layer — replaces the D1 binding (env.DB).
//
// D1                                  ->  here
//   env.DB.prepare(sql).bind(...)     ->  query(sql, { name: value })   (named @params)
//   .first() / .all().results         ->  (await query(...))[0] / await query(...)
//   env.DB.batch([...])               ->  withTx(async (tx) => { ... })  (all-or-nothing)
//   res.meta.last_row_id              ->  INSERT ... OUTPUT INSERTED.id
//
// Connection comes from the SQL_CONNECTION_STRING app setting.

const sql = require("mssql");

let poolPromise = null;

// Free-offer Azure SQL databases auto-pause when idle. The first connection
// after a pause can fail (error 40613) while the database resumes, so retry
// with backoff instead of surfacing a 500 to the first engineer of the day.
async function connectWithRetry(connectionString, attempts = 4) {
  for (let i = 1; ; i++) {
    try {
      const pool = new sql.ConnectionPool(connectionString);
      pool.on("error", () => { poolPromise = null; });
      return await pool.connect();
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 5000 * i));
    }
  }
}

function getPool() {
  if (!poolPromise) {
    const cs = process.env.SQL_CONNECTION_STRING;
    if (!cs) return Promise.reject(new Error("SQL_CONNECTION_STRING app setting is missing"));
    poolPromise = connectWithRetry(cs).catch((err) => {
      poolPromise = null;
      throw err;
    });
  }
  return poolPromise;
}

// Timestamp parameter. mssql would otherwise send a JS Date as the older
// DATETIME type (3.33 ms precision); the schema uses DATETIME2(3).
const ts = (date) => (date == null ? { type: sql.DateTime2(3), value: null } : { type: sql.DateTime2(3), value: date });

// Run a parameterised query. params: { name: value } or { name: { type, value } }.
// Pass tx to run inside a transaction started by withTx.
async function query(text, params = {}, tx) {
  const req = tx ? new sql.Request(tx) : (await getPool()).request();
  for (const [name, p] of Object.entries(params)) {
    if (p && typeof p === "object" && "type" in p && "value" in p) req.input(name, p.type, p.value);
    else req.input(name, p);
  }
  const res = await req.query(text);
  return res.recordset || [];
}

// All-or-nothing group of statements (the D1 batch equivalent).
async function withTx(fn) {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const out = await fn(tx);
    await tx.commit();
    return out;
  } catch (err) {
    try { await tx.rollback(); } catch { /* already rolled back */ }
    throw err;
  }
}

module.exports = { sql, query, withTx, ts };
