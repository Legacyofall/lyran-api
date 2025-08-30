// server.js  (CommonJS-version – funkar utan "type": "module")
const express = require("express");
const cors = require("cors");

const PORT = process.env.PORT || 3000;
const SWISH_NUMBER = process.env.SWISH_NUMBER || "123 456 78 90";

const app = express();
app.use(cors());
app.use(express.json());

// enkel logg
app.use((req, _res, next) => {
  console.log(new Date().toISOString(), req.method, req.url);
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "lyran-api", swish_number: SWISH_NUMBER });
});

app.get("/api/availability", (req, res) => {
  const { resource_type, date } = req.query;
  if (!resource_type || !date) {
    return res.status(400).json({ ok: false, error: "resource_type och date krävs" });
  }
  res.json({ ok: true, busy: [], blocks: [] });
});

app.post("/api/bookings", (req, res) => {
  const {
    resource_type, date, start_time, slots,
    customer_name, customer_phone, customer_email, age_confirmed
  } = req.body || {};

  if (!resource_type || !date || !start_time || !customer_name || !customer_phone) {
    return res.status(400).json({ ok: false, error: "Saknar fält (resource_type, date, start_time, customer_name, customer_phone)" });
  }

  const isGame = resource_type !== "table";
  const slotCount = isGame ? Math.max(1, Math.min(Number(slots || 1), 2)) : 1;
  const priceSek = isGame ? 50 * slotCount : 0;

  const booking = {
    id: randomId(),
    swish_ref: isGame ? ("BOKNING " + randomId().slice(0, 8).toUpperCase()) : null,
    amount_sek: priceSek,
    require_payment: isGame,
    swish_number: SWISH_NUMBER,
    echo: {
      resource_type, date, start_time,
      customer_name, customer_phone,
      customer_email: customer_email || null,
      age_confirmed: !!age_confirmed,
      slots: slotCount
    }
  };
  res.json({ ok: true, booking });
});

app.use("/api", (_req, res) => res.status(404).json({ ok: false, error: "Not found" }));

app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});

function randomId(){
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c=>{
    const r = Math.random()*16|0, v = c==="x"?r:(r&0x3|0x8);
    return v.toString(16);
  });
}
