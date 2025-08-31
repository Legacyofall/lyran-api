// server.js — Lyran API (CommonJS) med Postgres (Supabase) + IPv4-first fix
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

// Tvinga IPv4 först (fix för ENETUNREACH/IPv6)
const dns = require("dns");
try { dns.setDefaultResultOrder("ipv4first"); } catch (_) {}


// ---- Konfiguration ----
const PORT = process.env.PORT || 3000;
const SWISH_NUMBER = process.env.SWISH_NUMBER || "123 456 78 90";
const DATABASE_URL = process.env.DATABASE_URL || null;

// Regler/priser
const PRICE_SEK_PER_SLOT = 50;    // Biljard/Dart
const SLOT_MIN_POOL_DART = 45;
const MAX_SLOTS_POOL_DART = 2;
const TABLE_DURATION_MIN = 60;
const TABLE_BUFFER_MIN = 10;      // buffert för bord

// ---- App ----
const app = express();
app.use(cors());
app.use(express.json());

// DB-pool (Supabase kräver SSL). Om DATABASE_URL saknas kör vi "utan DB".
const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

// Enkel logg för felsökning
app.use((req, _res, next) => {
  console.log(new Date().toISOString(), req.method, req.url);
  next();
});

// Hjälpare
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
function randomId(){
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c=>{
    const r = Math.random()*16|0, v = c==="x" ? r : (r&0x3|0x8);
    return v.toString(16);
  });
}
function computeTimes(resource_type, date, start_hhmm, slots) {
  // Tolkning som serverns lokaltid (OK för MVP).
  const start = new Date(`${date}T${start_hhmm}`);
  const isGame = resource_type !== "table";
  const s = isGame ? clamp(Number(slots || 1), 1, MAX_SLOTS_POOL_DART) : 1;
  const durMin = isGame ? (s * SLOT_MIN_POOL_DART) : (TABLE_DURATION_MIN + TABLE_BUFFER_MIN);
  const end = new Date(start.getTime() + durMin * 60000);
  return { start, end, slots: s, isGame };
}

// ---- Routes ----

// Health: visar även DB-status + ev. felorsak
app.get("/api/health", async (_req, res) => {
  const env_has_db_url = !!DATABASE_URL;
  const db_pool_created = !!pool;
  let db_connected = false;
  let db_error = null;
  if (db_pool_created) {
    try { await pool.query("select 1"); db_connected = true; }
    catch (e) { db_error = e.message; console.error("DB test failed:", e); }
  }
  res.json({
    ok: true,
    service: "lyran-api",
    swish_number: SWISH_NUMBER,
    env_has_db_url,
    db_pool_created,
    db_connected,
    db_error
  });
});

// Availability: hämtar upptagna intervall för dag + resurstyp
// GET /api/availability?resource_type=pool_table&date=2025-09-01
app.get("/api/availability", async (req, res) => {
  const { resource_type, date } = req.query;
  if (!resource_type || !date) {
    return res.status(400).json({ ok:false, error:"resource_type och date krävs" });
  }

  // Utan DB: returnera tom lista (allt ledigt)
  if (!pool) return res.json({ ok:true, busy:[], blocks:[] });

  try {
    const dayStart = new Date(`${date}T00:00:00`);
    const dayEnd   = new Date(`${date}T23:59:59`);
    const { rows } = await pool.query(
      `select start_time, end_time
         from bookings
        where resource_type = $1
          and start_time >= $2 and start_time <= $3
          and status in ('pending_payment','confirmed')
        order by start_time`,
      [resource_type, dayStart, dayEnd]
    );
    return res.json({ ok:true, busy: rows, blocks: [] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, error:"DB-fel vid availability" });
  }
});

// Skapa bokning: sparar i DB. Spel kräver betalning (pending_payment), bord bekräftas direkt.
app.post("/api/bookings", async (req, res) => {
  const {
    resource_type, date, start_time, slots,
    customer_name, customer_phone, customer_email, age_confirmed
  } = req.body || {};

  if (!resource_type || !date || !start_time || !customer_name || !customer_phone) {
    return res.status(400).json({ ok:false, error:"Saknar fält (resource_type, date, start_time, customer_name, customer_phone)" });
  }

  const { start, end, slots: slotCount, isGame } =
    computeTimes(resource_type, date, start_time, slots);

  const priceSek = isGame ? (slotCount * PRICE_SEK_PER_SLOT) : 0;
  const swishRef = isGame ? ("BOKNING " + randomId().slice(0,8).toUpperCase()) : null;
  const status   = isGame ? "pending_payment" : "confirmed";

  try {
    let insertedId = null;

    if (pool) {
      const { rows } = await pool.query(
        `insert into bookings
          (resource_type, start_time, end_time, customer_name, customer_phone, customer_email,
           age_confirmed, price_ore, status, swish_ref)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         returning id`,
        [
          resource_type,
          start, end,
          customer_name, customer_phone, customer_email || null,
          !!age_confirmed, priceSek * 100,
          status,
          swishRef
        ]
      );
      insertedId = rows?.[0]?.id || null;
    }

    return res.json({
      ok: true,
      booking: {
        id: insertedId || randomId(),  // om DB saknas får du ändå ett id-liknande värde
        swish_ref: swishRef,
        amount_sek: priceSek,
        require_payment: isGame,
        swish_number: SWISH_NUMBER
      }
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, error:"DB-fel vid skapande" });
  }
});

// Enkel listning av bokningar (MVP)
// GET /api/admin/bookings?date=YYYY-MM-DD  (valfritt queryparam)
app.get("/api/admin/bookings", async (req, res) => {
  if (!pool) return res.json({ ok:true, bookings:[] });

  const { date } = req.query;
  try {
    let rows;
    if (date) {
      const dayStart = new Date(`${date}T00:00:00`);
      const dayEnd   = new Date(`${date}T23:59:59`);
      ({ rows } = await pool.query(
        `select id, resource_type, start_time, end_time, customer_name, customer_phone, status, swish_ref, created_at
           from bookings
          where start_time >= $1 and start_time <= $2
          order by start_time`,
        [dayStart, dayEnd]
      ));
    } else {
      ({ rows } = await pool.query(
        `select id, resource_type, start_time, end_time, customer_name, customer_phone, status, swish_ref, created_at
           from bookings
          order by created_at desc
          limit 100`
      ));
    }
    return res.json({ ok:true, bookings: rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, error:"DB-fel vid listning" });
  }
});

// 404-fångare för /api/*
app.use("/api", (_req, res) => res.status(404).json({ ok:false, error:"Not found" }));

// Global felhanterare (sista utväg)
app.use((err, _req, res, _next) => {
  console.error("Unexpected error:", err);
  res.status(500).json({ ok:false, error:"Serverfel" });
});

// Start
app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});
