"use strict";

/**
 * 快搭公車 BusGo — Backend v3
 * 修正：ETA 用 StopUID 查（非 StopName），StopUID 從 Stop API 取得
 */

const express = require("express");
const axios   = require("axios");
const cors    = require("cors");
require("dotenv").config();

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════
// § 1  TDX OAuth2 Token (25-min cache)
// ═══════════════════════════════════════════════
const TDX_AUTH = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const TDX_BUS  = "https://tdx.transportdata.tw/api/basic/v2/Bus";

let _tok = null, _tokExp = 0;

async function getToken() {
  if (_tok && Date.now() < _tokExp) return _tok;
  const body = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     process.env.TDX_CLIENT_ID     ?? "",
    client_secret: process.env.TDX_CLIENT_SECRET ?? "",
  });
  const { data } = await axios.post(TDX_AUTH, body, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  _tok    = data.access_token;
  _tokExp = Date.now() + 25 * 60 * 1000;
  console.log("[TDX] Token refreshed");
  return _tok;
}

const auth = (tok) => ({ Authorization: `Bearer ${tok}` });

// ═══════════════════════════════════════════════
// § 2  TTL Cache
// ═══════════════════════════════════════════════
const _cache = new Map();

function cGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { _cache.delete(key); return null; }
  return e.v;
}

function cSet(key, v, ttl = 5 * 60 * 1000) {
  _cache.set(key, { v, exp: Date.now() + ttl });
}

// ═══════════════════════════════════════════════
// § 3  TDX Helpers
// ═══════════════════════════════════════════════

// 用站名搜尋站牌，回傳 StopUID 列表（後端 filter，最穩定）
async function searchStopsByName(city, name, tok) {
  const key = `stops:${city}`;
  let allStops = cGet(key);

  if (!allStops) {
    const url = `${TDX_BUS}/Stop/City/${city}?$top=10000&$format=JSON`;
    const { data } = await axios.get(url, { headers: auth(tok) });
    allStops = data;
    cSet(key, allStops, 10 * 60 * 1000); // 10-min cache
    console.log(`[TDX] Loaded ${allStops.length} stops for ${city}`);
  }

  // 後端直接 filter
  return allStops.filter(s =>
    (s.StopName?.Zh_tw ?? "").includes(name)
  );
}

// 用 StopUID 查 ETA（即時，不 cache）
async function fetchETAByUID(city, stopUID, tok) {
  const url = `${TDX_BUS}/EstimatedTimeOfArrival/City/${city}/StopUID/${stopUID}?$top=200&$format=JSON`;
  const { data } = await axios.get(url, { headers: auth(tok) });
  return data;
}

// 取得路線停靠站（RouteName 查，5-min cache）
async function fetchStopOfRoute(city, routeName, tok) {
  const key = `sor:${city}:${routeName}`;
  const hit = cGet(key);
  if (hit) return hit;

  const url = `${TDX_BUS}/StopOfRoute/City/${city}/RouteName/${encodeURIComponent(routeName)}?$format=JSON`;
  const { data } = await axios.get(url, { headers: auth(tok) });
  cSet(key, data);
  return data;
}

// ═══════════════════════════════════════════════
// § 4  GET /api/search-stop
//   搜尋站牌（前端 autocomplete）
//   Query: q=台北車站, city=Taipei
// ═══════════════════════════════════════════════
app.get("/api/search-stop", async (req, res) => {
  const { q = "", city = "Taipei" } = req.query;
  const name = q.trim();

  if (name.length === 0)
    return res.status(400).json({ error: "q is required" });

  try {
    const tok   = await getToken();
    const stops = await searchStopsByName(city, name, tok);

    // 去重：同站名只留一筆
    const seen = new Set();
    const results = [];
    for (const s of stops) {
      const stopName = s.StopName?.Zh_tw ?? "";
      if (!stopName || seen.has(stopName)) continue;
      seen.add(stopName);
      results.push({
        stopName,
        stopUID:  s.StopUID ?? "",
        city,
      });
    }

    res.json({ results, q, city });
  } catch (err) {
    console.error("[search-stop]", err.response?.status, err.message);
    res.status(500).json({ error: "站牌查詢失敗", detail: err.message });
  }
});

// ═══════════════════════════════════════════════
// § 5  GET /api/bus-arrivals
//   主查詢：搭車站名 + 目的地關鍵字
//   Query: stopName=台北車站, keyword=松山, city=Taipei
// ═══════════════════════════════════════════════
app.get("/api/bus-arrivals", async (req, res) => {
  const { stopName, keyword, city = "Taipei" } = req.query;

  if (!stopName || !keyword)
    return res.status(400).json({ error: "stopName and keyword are required" });

  try {
    const tok = await getToken();

    // ── A: 找出所有符合站名的 StopUID ──────────
    const stops = await searchStopsByName(city, stopName.trim(), tok);

    if (stops.length === 0) {
      return res.json({
        routes: [], stopName, keyword,
        hint: `找不到「${stopName}」，請確認站名（支援模糊搜尋，例如輸入「台北」）`,
      });
    }

    // 取前 5 個 StopUID（同站名可能有多個方向）
    const stopUIDs = [...new Set(stops.map(s => s.StopUID))].slice(0, 5);
    console.log(`[bus-arrivals] stopName=${stopName}, UIDs=${stopUIDs.join(",")}`);

    // ── B: 並行查所有 StopUID 的 ETA ───────────
    const etaResults = await Promise.allSettled(
      stopUIDs.map(uid => fetchETAByUID(city, uid, tok))
    );

    // 合併所有 ETA 資料
    const allETA = [];
    for (const r of etaResults) {
      if (r.status === "fulfilled" && Array.isArray(r.value)) {
        allETA.push(...r.value);
      }
    }

    if (allETA.length === 0) {
      return res.json({ routes: [], stopName, keyword, hint: "此站目前無公車資料" });
    }

    // ── C: 整理 routeMap（每條路線保留最小 ETA）
    const routeMap = new Map();

    for (const item of allETA) {
      const rName = item.RouteName?.Zh_tw;
      if (!rName) continue;

      const dir = item.Direction ?? 0;
      const key = `${rName}:${dir}`;
      const eta = item.EstimateTime ?? null;

      const prev = routeMap.get(key);
      if (!prev || (eta !== null && (prev.etaSec === null || eta < prev.etaSec))) {
        routeMap.set(key, {
          routeUID:  item.RouteUID ?? rName,
          routeName: rName,
          direction: dir === 0 ? "去程" : "返程",
          dirLabel:  item.DestinationStopName?.Zh_tw
            ? `往 ${item.DestinationStopName.Zh_tw}`
            : (dir === 0 ? "去程" : "返程"),
          etaSec:    eta,
          etaMin:    eta !== null ? Math.ceil(eta / 60) : null,
          plateNumb: item.PlateNumb ?? null,
        });
      }
    }

    if (routeMap.size === 0)
      return res.json({ routes: [], stopName, keyword });

    // ── D: StopOfRoute 並行查詢（比對目的地）──
    const entries     = [...routeMap.values()];
    const uniqueNames = [...new Set(entries.map(e => e.routeName))];

    const sorResults = await Promise.allSettled(
      uniqueNames.map(n => fetchStopOfRoute(city, n, tok))
    );

    const nameMap = new Map();
    for (let i = 0; i < uniqueNames.length; i++) {
      const r = sorResults[i];
      if (r.status !== "fulfilled") continue;
      const s = new Set();
      for (const sub of r.value ?? []) {
        for (const stop of sub.Stops ?? []) {
          const n = stop.StopName?.Zh_tw ?? "";
          if (n) s.add(n);
        }
      }
      nameMap.set(uniqueNames[i], s);
    }

    // ── E: 合併 + keyword 比對 ─────────────────
    const kw = keyword.trim();

    const routes = entries.map(e => {
      const names           = nameMap.get(e.routeName) ?? new Set();
      const hasDestination  = [...names].some(n => n.includes(kw));
      const destinationStop = hasDestination
        ? ([...names].find(n => n.includes(kw)) ?? null)
        : null;

      return {
        routeUID:       e.routeUID,
        routeName:      e.routeName,
        direction:      e.direction,
        directionLabel: e.dirLabel,
        etaMin:         e.etaMin,
        plateNumb:      e.plateNumb,
        hasDestination,
        destinationStop,
      };
    });

    // ── F: 排序（有目的地優先，ETA 小到大）────
    routes.sort((a, b) => {
      if (a.hasDestination !== b.hasDestination) return a.hasDestination ? -1 : 1;
      if (a.etaMin === null && b.etaMin === null) return 0;
      if (a.etaMin === null) return 1;
      if (b.etaMin === null) return -1;
      return a.etaMin - b.etaMin;
    });

    res.json({ routes, stopName, keyword, total: routes.length });

  } catch (err) {
    console.error("[bus-arrivals]", err.response?.status, err.message);
    res.status(500).json({ error: "TDX 錯誤", detail: err.message });
  }
});

// ═══════════════════════════════════════════════
// § 6  Health checks
// ═══════════════════════════════════════════════
app.get("/health", (_, res) =>
  res.json({ ok: true, uptime: Math.round(process.uptime()), ts: new Date() })
);

app.get("/health/token", async (_, res) => {
  try {
    const tok = await getToken();
    res.json({ ok: true, tokenLength: tok.length });
  } catch (e) {
    res.status(500).json({ ok: false, detail: e.message });
  }
});

// ── 診斷端點 ──────────────────────────────────
app.get("/debug/stop", async (req, res) => {
  const { city = "Taipei" } = req.query;
  try {
    const tok = await getToken();
    const url = `${TDX_BUS}/Stop/City/${city}?$top=3&$format=JSON`;
    const { data } = await axios.get(url, { headers: auth(tok) });
    res.json({ count: data.length, sample: data.slice(0, 2) });
  } catch(e) {
    res.json({ error: e.message, status: e.response?.status });
  }
});

app.get("/debug/eta", async (req, res) => {
  const { uid = "TPE10000", city = "Taipei" } = req.query;
  try {
    const tok = await getToken();
    const url = `${TDX_BUS}/EstimatedTimeOfArrival/City/${city}/StopUID/${uid}?$top=3&$format=JSON`;
    const { data } = await axios.get(url, { headers: auth(tok) });
    res.json({ uid, count: Array.isArray(data) ? data.length : "not_array", sample: Array.isArray(data) ? data.slice(0,2) : data });
  } catch(e) {
    res.json({ error: e.message, status: e.response?.status, body: e.response?.data });
  }
});

app.listen(PORT, () =>
  console.log(`🚌 BusGo v3 → http://localhost:${PORT}`)
);
