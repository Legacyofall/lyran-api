// server.js — Lyran API (CommonJS) med Postgres (Supabase)
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

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

// Hjälp: räkna ut start/slut utifrån typ/slots
function computeTimes(resource_type, date, start_hhmm, slots) {
  // Tolkning som serverns lokaltid (duger för MVP). Vi kan sätta TZ senare om vi vill låsa till Europe/Stockholm.
  const start = new Date(`${date}T${start_hhmm}`);
  const isGame = resource_type !== "table";
  const s = isGame ? clamp(Number(slots || 1), 1, MAX_SLOTS_POOL_DART) : 1;
  const durMin = isGame ? (s * SLOT_MIN_POOL_DART) : (TABLE_DURATION_MIN + TABLE_BUFFER_MIN);
  const end = new Date(start.getTime() + durMin * 60000);
  return { start, end, slots: s, isGame };
}
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
function randomId(){
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c=>{
    const r = Math.random()*16|0, v = c==="x" ? r : (r&0x3|0x8);
    return v.toString(16);
  });
}

// ---- Routes ----

// Health: visar även DB-status tydligt
app.get("/api/health", async (_req, res) => {
  const env_has_db_url = !!DATABASE_URL;
  const db_pool_created = !!pool;
  let db_connected = false;
  if (db_pool_created) {
    try { await pool.query("select 1"); db_connected = true; }
    catch (e) { console.error("DB test failed:", e.message); }
  }
  res.json({
    ok: true,
    service: "lyran-api",
    swish_number: SWISH_NUMBER,
    env_has_db_url,
    db_pool_created,
    db_connected
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
