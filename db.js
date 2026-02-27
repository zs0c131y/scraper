"use strict";

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

// ─── Config ───────────────────────────────────────────────────────────────────
const BUDGET_USD = parseFloat(process.env.BUDGET_USD || "4.00");

// Store DB in /data if it exists (Railway volume mount), else project root
const DB_DIR = fs.existsSync("/data") ? "/data" : __dirname;
const DB_PATH = path.join(DB_DIR, "captura.db");

// Railway pricing
const MEM_RATE = 0.00000386; // $ per GB per second
const CPU_RATE = 0.00000772; // $ per vCPU per second

// ─── Init ─────────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint    TEXT    NOT NULL,
    url         TEXT,
    started_at  INTEGER NOT NULL,
    duration_ms INTEGER,
    status_code INTEGER,
    error       TEXT
  );

  CREATE TABLE IF NOT EXISTS billing (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    sampled_at      INTEGER NOT NULL,
    elapsed_sec     REAL    NOT NULL,
    mem_gb          REAL    NOT NULL,
    cpu_vcpu        REAL    NOT NULL,
    mem_cost        REAL    NOT NULL,
    cpu_cost        REAL    NOT NULL,
    sample_cost     REAL    NOT NULL,
    cumulative_cost REAL    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Seed defaults if not present
  INSERT OR IGNORE INTO state VALUES ('shutdown', '0');
  INSERT OR IGNORE INTO state VALUES ('budget_usd', '${BUDGET_USD}');
  INSERT OR IGNORE INTO state VALUES ('cumulative_cost', '0');
  INSERT OR IGNORE INTO state VALUES ('total_requests', '0');
`);

// ─── Prepared statements ──────────────────────────────────────────────────────
const stmts = {
  insertRequest: db.prepare(`
    INSERT INTO requests (endpoint, url, started_at, duration_ms, status_code, error)
    VALUES (@endpoint, @url, @started_at, @duration_ms, @status_code, @error)
  `),
  insertBilling: db.prepare(`
    INSERT INTO billing (sampled_at, elapsed_sec, mem_gb, cpu_vcpu, mem_cost, cpu_cost, sample_cost, cumulative_cost)
    VALUES (@sampled_at, @elapsed_sec, @mem_gb, @cpu_vcpu, @mem_cost, @cpu_cost, @sample_cost, @cumulative_cost)
  `),
  getState: db.prepare("SELECT value FROM state WHERE key = ?"),
  setState: db.prepare("INSERT OR REPLACE INTO state VALUES (?, ?)"),
  countReqs: db.prepare("SELECT COUNT(*) AS n FROM requests"),
  recentReqs: db.prepare(
    "SELECT endpoint, url, started_at, duration_ms, status_code FROM requests ORDER BY id DESC LIMIT 50",
  ),
  billingLast: db.prepare("SELECT * FROM billing ORDER BY id DESC LIMIT 1"),
  billingSince: db.prepare(`
    SELECT SUM(sample_cost) AS total FROM billing WHERE sampled_at > ?
  `),
  billingHistory: db.prepare(`
    SELECT sampled_at, mem_gb, cpu_vcpu, sample_cost, cumulative_cost
    FROM billing ORDER BY id DESC LIMIT 100
  `),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getStateVal(key) {
  const row = stmts.getState.get(key);
  return row ? row.value : null;
}

function setStateVal(key, value) {
  stmts.setState.run(key, String(value));
}

function getCumulativeCost() {
  return parseFloat(getStateVal("cumulative_cost") || "0");
}

function getBudget() {
  return parseFloat(getStateVal("budget_usd") || BUDGET_USD);
}

function isShutdown() {
  return getStateVal("shutdown") === "1";
}

// ─── Log a request ────────────────────────────────────────────────────────────
function logRequest({
  endpoint,
  url,
  startedAt,
  durationMs,
  statusCode,
  error,
}) {
  stmts.insertRequest.run({
    endpoint,
    url: url || null,
    started_at: startedAt,
    duration_ms: durationMs || null,
    status_code: statusCode || null,
    error: error || null,
  });

  // bump total_requests counter in state
  const cur = parseInt(getStateVal("total_requests") || "0");
  setStateVal("total_requests", cur + 1);
}

// ─── Billing sampler ──────────────────────────────────────────────────────────
let _lastCpuUsage = process.cpuUsage();
let _lastSampleAt = Date.now();

function takeBillingSample() {
  const now = Date.now();
  const elapsedMs = now - _lastSampleAt;
  const elapsedSec = elapsedMs / 1000;

  if (elapsedSec < 1) return; // guard against tiny intervals

  // Memory
  const memGb = process.memoryUsage().rss / 1024 ** 3;

  // CPU — cpuUsage() returns microseconds of user+system CPU time
  const cpuDelta = process.cpuUsage(_lastCpuUsage);
  const cpuSecs = (cpuDelta.user + cpuDelta.system) / 1e6; // actual CPU-seconds used
  const cpuVcpu = Math.min(cpuSecs / elapsedSec, 8); // fraction of 1 vCPU (cap at 8)

  // Costs for this interval
  const memCost = memGb * elapsedSec * MEM_RATE;
  const cpuCost = cpuVcpu * elapsedSec * CPU_RATE;
  const sampleCost = memCost + cpuCost;

  // Accumulate
  const prevCumulative = getCumulativeCost();
  const newCumulative = prevCumulative + sampleCost;

  stmts.insertBilling.run({
    sampled_at: now,
    elapsed_sec: elapsedSec,
    mem_gb: memGb,
    cpu_vcpu: cpuVcpu,
    mem_cost: memCost,
    cpu_cost: cpuCost,
    sample_cost: sampleCost,
    cumulative_cost: newCumulative,
  });

  setStateVal("cumulative_cost", newCumulative.toFixed(8));

  // Update CPU baseline AFTER reading delta
  _lastCpuUsage = process.cpuUsage();
  _lastSampleAt = now;

  // Check budget
  const budget = getBudget();
  if (newCumulative >= budget && !isShutdown()) {
    setStateVal("shutdown", "1");
    console.warn(
      `\n⚠ BUDGET LIMIT REACHED: $${newCumulative.toFixed(4)} >= $${budget}. API suspended.\n`,
    );
  }

  return { memGb, cpuVcpu, sampleCost, cumulative: newCumulative };
}

// Start billing loop (every 30 seconds)
const SAMPLE_INTERVAL_MS = parseInt(process.env.BILLING_SAMPLE_MS || "30000");
let billingTimer = setInterval(takeBillingSample, SAMPLE_INTERVAL_MS);
billingTimer.unref(); // Don't block process exit

// ─── Stats export ─────────────────────────────────────────────────────────────
function getFullStats() {
  const cumulative = getCumulativeCost();
  const budget = getBudget();
  const shutdown = isShutdown();
  const lastBilling = stmts.billingLast.get() || {};
  const totalReqs = parseInt(getStateVal("total_requests") || "0");

  return {
    billing: {
      cumulativeCostUsd: parseFloat(cumulative.toFixed(6)),
      budgetUsd: budget,
      remainingUsd: parseFloat(Math.max(0, budget - cumulative).toFixed(6)),
      percentUsed: parseFloat(
        Math.min(100, (cumulative / budget) * 100).toFixed(2),
      ),
      shutdown,
      lastSample: lastBilling.sampled_at
        ? {
            memGb: parseFloat((lastBilling.mem_gb || 0).toFixed(4)),
            cpuVcpu: parseFloat((lastBilling.cpu_vcpu || 0).toFixed(4)),
            sampleCost: parseFloat((lastBilling.sample_cost || 0).toFixed(8)),
          }
        : null,
    },
    requests: {
      total: totalReqs,
    },
  };
}

function getRecentRequests() {
  return stmts.recentReqs.all();
}

function getBillingHistory() {
  return stmts.billingHistory.all().reverse();
}

// ─── Admin: reset shutdown (in case you want to keep the site up after adding funds) ──
function resetShutdown(newBudget) {
  if (newBudget !== undefined) setStateVal("budget_usd", newBudget);
  setStateVal("shutdown", "0");
}

module.exports = {
  db,
  logRequest,
  takeBillingSample,
  isShutdown,
  getCumulativeCost,
  getBudget,
  getFullStats,
  getRecentRequests,
  getBillingHistory,
  resetShutdown,
  RATES: { MEM_RATE, CPU_RATE },
};
