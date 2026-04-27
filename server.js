"use strict";

/**
 * 快搭公車 BusGo — Backend v4
 * 正確流程：
 *  1. 查該城市所有路線 Route
 *  2. 查每條路線的 StopOfRoute → 找出哪些路線停靠「搭車站」
 *  3. 對這些路線查 ETA（用 RouteName）
 *  4. 同時比對哪些路線也停靠「目的地」
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

// 取得城市所有路線（15-min cache）
async function fetchAllRoutes(city, tok) {
  const key = `routes:${city}`;
  const hit = cGet(key);
  if (hit) return hit;

  const url = `${TDX_BUS}/Route/City/${city}?$select=RouteUID,RouteName&$top=1000&$format=JSON`;
  const { data } = await axios.get(url, { headers: auth(tok) });
  cSet(key, data, 15 * 60 * 1000);
  console.log(`[TDX] Loaded ${data.length} routes for ${city}`);
  return data;
}

// 取得路線的所有停靠站（10-min cache）
async function fetchStopOfRoute(city, routeName, tok) {
  const key = `sor:${city}:${routeName}`;
  const hit = cGet(key);
  if (hit) return hit;

  const url = `${TDX_BUS}/StopOfRoute/City/${city}/RouteName/${encodeURIComponent(routeName)}?$format=JSON`;
  const { data } = await axios.get(url, { headers: auth(tok) });
  cSet(key, data, 10 * 60 * 1000);
  return data;
}

// 取得路線即時 ETA（不 cache，即時資料）
async function fetchETAByRoute(city, routeName, tok) {
  const url = `${TDX_BUS}/EstimatedTimeOfArrival/City/${city}/RouteName/${encodeURIComponent(routeName)}?$format=JSON`;
  const { data } = await axios.get(url, { headers: auth(tok) });
  return data;
}

// ═══════════════════════════════════════════════
// § 4  GET /api/search-stop
//   搜尋站牌名稱（autocomplete 用）
//   做法：從 StopOfRoute 第一條路線掃站名
//   Query: q=台北車站, city=Taipei
// ═══════════════════════════════════════════════
app.get("/api/search-stop", async (req, res) => {
  const { q = "", city = "Taipei" } = req.query;
  const name = q.trim();
  if (name.length === 0)
    return res.status(400).json({ error: "q is required" });

  try {
    const tok = await getToken();

    // 用 Stop API 搜站名（後端 filter）
    const key = `allstops:${city}`;
    let allStops = cGet(key);
    if (!allStops) {
      const url = `${TDX_BUS}/Stop/City/${city}?$top=10000&$format=JSON`;
      const { data } = await axios.get(url, { headers: auth(tok) });
      allStops = data;
      cSet(key, allStops, 15 * 60 * 1000);
      console.log(`[TDX] Loaded ${allStops.length} stops for ${city}`);
    }

    const matched = allStops.filter(s =>
      (s.StopName?.Zh_tw ?? "").includes(name)
    );

    const seen = new Set();
    const results = [];
    for (const s of matched) {
      const stopName = s.StopName?.Zh_tw ?? "";
      if (!stopName || seen.has(stopName)) continue;
      seen.add(stopName);
      results.push({ stopName, stopUID: s.StopUID ?? "", city });
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
//
//   Pipeline：
//   A. 取得城市所有路線
//   B. 並行查各路線 StopOfRoute，找出停靠「搭車站」的路線
//   C. 對這些路線查 ETA（RouteName）
//   D. 同時記錄哪些路線也停靠「目的地」
//   E. 合併排序回傳
// ═══════════════════════════════════════════════
app.get("/api/bus-arrivals", async (req, res) => {
  const { stopName, keyword, city = "Taipei" } = req.query;

  if (!stopName || !keyword)
    return res.status(400).json({ error: "stopName and keyword are required" });

  try {
    const tok = await getToken();

    // ── A: 取得所有路線 ─────────────────────────
    const allRoutes = await fetchAllRoutes(city, tok);
    const routeNames = [...new Set(allRoutes.map(r => r.RouteName?.Zh_tw).filter(Boolean))];

    console.log(`[bus-arrivals] Checking ${routeNames.length} routes for stopName=${stopName}`);

    // ── B: 並行查 StopOfRoute，找停靠搭車站的路線
    // 分批處理避免一次打太多 API（每批 20 條）
    const BATCH = 20;
    const matchedRoutes = []; // { routeName, hasDestination, destinationStop }

    for (let i = 0; i < routeNames.length; i += BATCH) {
      const batch = routeNames.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(n => fetchStopOfRoute(city, n, tok))
      );

      for (let j = 0; j < batch.length; j++) {
        const r = results[j];
        if (r.status !== "fulfilled") continue;

        const stopNames = new Set();
        for (const sub of r.value ?? []) {
          for (const stop of sub.Stops ?? []) {
            const sn = stop.StopName?.Zh_tw ?? "";
            if (sn) stopNames.add(sn);
          }
        }

        const stopsAtBoard  = [...stopNames].some(n => n.includes(stopName.trim()));
        if (!stopsAtBoard) continue;

        const hasDestination  = [...stopNames].some(n => n.includes(keyword.trim()));
        const destinationStop = hasDestination
          ? ([...stopNames].find(n => n.includes(keyword.trim())) ?? null)
          : null;

        matchedRoutes.push({ routeName: batch[j], hasDestination, destinationStop });
      }
    }

    console.log(`[bus-arrivals] Found ${matchedRoutes.length} routes stopping at ${stopName}`);

    if (matchedRoutes.length === 0) {
      return res.json({
        routes: [], stopName, keyword,
        hint: `找不到停靠「${stopName}」的路線，請確認站名（可用部分名稱搜尋）`,
      });
    }

    // ── C: 查這些路線的 ETA ─────────────────────
    const etaResults = await Promise.allSettled(
      matchedRoutes.map(r => fetchETAByRoute(city, r.routeName, tok))
    );

    // ── D: 合併 ETA + 站點資訊 ──────────────────
    const routeMap = new Map();

    for (let i = 0; i < matchedRoutes.length; i++) {
      const etaResult = etaResults[i];
      if (etaResult.status !== "fulfilled") continue;

      const { routeName, hasDestination, destinationStop } = matchedRoutes[i];
      const etaList = etaResult.value ?? [];

      // 找出在搭車站的 ETA（StopName 包含 stopName）
      for (const item of etaList) {
        const sn = item.StopName?.Zh_tw ?? "";
        if (!sn.includes(stopName.trim())) continue;

        const dir = item.Direction ?? 0;
        const key = `${routeName}:${dir}`;
        const eta = item.EstimateTime ?? null;

        const prev = routeMap.get(key);
        if (!prev || (eta !== null && (prev.etaSec === null || eta < prev.etaSec))) {
          routeMap.set(key, {
            routeName,
            direction:      dir === 0 ? "去程" : "返程",
            dirLabel:       item.DestinationStopName?.Zh_tw
              ? `往 ${item.DestinationStopName.Zh_tw}`
              : (dir === 0 ? "去程" : "返程"),
            etaSec:         eta,
            etaMin:         eta !== null ? Math.ceil(eta / 60) : null,
            plateNumb:      item.PlateNumb ?? null,
            hasDestination,
            destinationStop,
          });
        }
      }

      // 如果這條路線在 ETA 裡找不到搭車站的記錄，仍然列出（顯示 — 分鐘）
      const key0 = `${routeName}:0`;
      const key1 = `${routeName}:1`;
      if (!routeMap.has(key0) && !routeMap.has(key1)) {
        routeMap.set(key0, {
          routeName,
          direction:      "去程",
          dirLabel:       "去程",
          etaSec:         null,
          etaMin:         null,
          plateNumb:      null,
          hasDestination,
          destinationStop,
        });
      }
    }

    // ── E: 排序 ─────────────────────────────────
    const routes = [...routeMap.values()].sort((a, b) => {
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
// § 6  Health checks & Debug
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

// 測試 ETA by RouteName
app.get("/debug/eta", async (req, res) => {
  const { route = "307", city = "Taipei" } = req.query;
  try {
    const tok = await getToken();
    const url = `${TDX_BUS}/EstimatedTimeOfArrival/City/${city}/RouteName/${encodeURIComponent(route)}?$top=5&$format=JSON`;
    const { data } = await axios.get(url, { headers: auth(tok) });
    res.json({ route, count: Array.isArray(data) ? data.length : "not_array", sample: Array.isArray(data) ? data.slice(0,3) : data });
  } catch(e) {
    res.json({ error: e.message, status: e.response?.status });
  }
});

app.listen(PORT, () =>
  console.log(`🚌 BusGo v4 → http://localhost:${PORT}`)
);
