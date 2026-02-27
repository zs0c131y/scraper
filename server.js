"use strict";

const express = require("express");
const puppeteer = require("puppeteer");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const path = require("path");
const billing = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG = {
  API_KEY: process.env.API_KEY || null, // Optional. Set to require auth.
  MAX_CONCURRENT_PAGES: parseInt(process.env.MAX_CONCURRENT_PAGES || "3"),
  PAGE_TIMEOUT_MS: parseInt(process.env.PAGE_TIMEOUT_MS || "30000"),
  IDLE_BROWSER_TIMEOUT_MS: parseInt(
    process.env.IDLE_BROWSER_TIMEOUT_MS || "300000",
  ), // 5 min
  MAX_REQUESTS_PER_MINUTE: parseInt(
    process.env.MAX_REQUESTS_PER_MINUTE || "30",
  ),
  ALLOW_LOCALHOST: process.env.ALLOW_LOCALHOST === "true",
};

// ─── Browser Pool ─────────────────────────────────────────────────────────────
class BrowserPool {
  constructor() {
    this.browser = null;
    this.activeCount = 0;
    this.queue = [];
    this.isLaunching = false;
    this.idleTimer = null;
    this.stats = { totalRequests: 0, totalErrors: 0, uptime: Date.now() };
  }

  getLaunchArgs() {
    return [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", // Use /tmp instead of /dev/shm (critical for containers)
      "--disable-accelerated-2d-canvas",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-breakpad",
      "--disable-client-side-phishing-detection",
      "--disable-component-extensions-with-background-pages",
      "--disable-default-apps",
      "--disable-hang-monitor",
      "--disable-ipc-flooding-protection",
      "--disable-popup-blocking",
      "--disable-prompt-on-repost",
      "--disable-renderer-backgrounding",
      "--disable-sync",
      "--disable-translate",
      "--force-color-profile=srgb",
      "--metrics-recording-only",
      "--mute-audio",
      "--no-first-run",
      "--safebrowsing-disable-auto-update",
      "--hide-scrollbars",
      "--window-size=1280,800",
      // Memory limits
      "--js-flags=--max-old-space-size=256",
    ];
  }

  async launch() {
    if (this.isLaunching) {
      // Wait for in-progress launch
      await new Promise((res) => {
        const check = setInterval(() => {
          if (!this.isLaunching) {
            clearInterval(check);
            res();
          }
        }, 100);
      });
      return;
    }

    this.isLaunching = true;
    console.log("[Browser] Launching Chromium...");

    try {
      this.browser = await puppeteer.launch({
        headless: true,
        args: this.getLaunchArgs(),
        ...(process.env.CHROMIUM_PATH
          ? { executablePath: process.env.CHROMIUM_PATH }
          : {}),
      });

      this.browser.on("disconnected", () => {
        console.log("[Browser] Disconnected. Will restart on next request.");
        this.browser = null;
        this.activeCount = 0;
      });

      console.log("[Browser] Ready.");
    } catch (err) {
      console.error("[Browser] Launch failed:", err.message);
      this.browser = null;
      throw err;
    } finally {
      this.isLaunching = false;
    }
  }

  async ensureBrowser() {
    if (!this.browser) {
      await this.launch();
    } else {
      // Health check
      try {
        await this.browser.version();
      } catch {
        console.log("[Browser] Health check failed, relaunching...");
        this.browser = null;
        await this.launch();
      }
    }

    // Reset idle shutdown timer
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(
      () => this.shutdownIfIdle(),
      CONFIG.IDLE_BROWSER_TIMEOUT_MS,
    );
  }

  async shutdownIfIdle() {
    if (this.activeCount === 0 && this.browser) {
      console.log(
        "[Browser] Idle timeout reached. Shutting down to conserve memory.",
      );
      try {
        await this.browser.close();
      } catch {}
      this.browser = null;
    }
  }

  async withPage(fn) {
    this.stats.totalRequests++;

    // Queue if at capacity
    if (this.activeCount >= CONFIG.MAX_CONCURRENT_PAGES) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(new Error("Queue timeout: too many concurrent requests")),
          CONFIG.PAGE_TIMEOUT_MS,
        );
        this.queue.push(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }

    await this.ensureBrowser();
    this.activeCount++;

    const page = await this.browser.newPage();

    // Stealth: set realistic headers
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
    });

    try {
      return await fn(page);
    } catch (err) {
      this.stats.totalErrors++;
      throw err;
    } finally {
      try {
        await page.close();
      } catch {}
      this.activeCount--;

      // Drain queue
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        next();
      }
    }
  }

  getStats() {
    return {
      ...this.stats,
      activePages: this.activeCount,
      queueLength: this.queue.length,
      browserAlive: !!this.browser,
      uptimeSeconds: Math.floor((Date.now() - this.stats.uptime) / 1000),
    };
  }
}

const pool = new BrowserPool();

// ─── Shutdown page ────────────────────────────────────────────────────────────
function shutdownPage() {
  const stats = billing.getFullStats();
  const cost = stats.billing.cumulativeCostUsd.toFixed(4);
  const budg = stats.billing.budgetUsd.toFixed(2);
  const pct = stats.billing.percentUsed.toFixed(1);
  const reqs = stats.requests.total;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>CAPTURA — Service Suspended</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#020408;--card:#0d1322;--border:#1d2d45;
  --red:#ff4e6a;--red-dim:rgba(255,78,106,.12);
  --amber:#ffb800;--text-1:#e8f0ff;--text-2:#8ea0bc;--text-3:#4a5e7a;
  --mono:'JetBrains Mono',monospace;--ui:'Syne',sans-serif;
}
html,body{height:100%;font-family:var(--ui);background:var(--bg);color:var(--text-1)}
body{
  display:flex;align-items:center;justify-content:center;min-height:100vh;
  background:
    radial-gradient(ellipse 70% 50% at 50% 0%,rgba(255,78,106,.06) 0%,transparent 60%),
    radial-gradient(ellipse 50% 40% at 80% 100%,rgba(255,78,106,.04) 0%,transparent 50%),
    var(--bg);
}
body::after{
  content:'';position:fixed;inset:0;
  background-image:linear-gradient(rgba(255,78,106,.015) 1px,transparent 1px),linear-gradient(90deg,rgba(255,78,106,.015) 1px,transparent 1px);
  background-size:48px 48px;pointer-events:none;z-index:0;
  mask-image:radial-gradient(ellipse 80% 80% at 50% 0%,black 30%,transparent 100%);
}
.card{
  position:relative;z-index:1;max-width:520px;width:90%;
  background:var(--card);border:1px solid rgba(255,78,106,.25);
  border-radius:20px;padding:48px 40px;text-align:center;
  box-shadow:0 0 60px rgba(255,78,106,.08),0 24px 48px rgba(0,0,0,.5);
}
.icon{
  width:64px;height:64px;border-radius:16px;margin:0 auto 28px;
  background:var(--red-dim);border:1px solid rgba(255,78,106,.2);
  display:grid;place-items:center;font-size:28px;
  box-shadow:0 0 30px rgba(255,78,106,.15);
}
h1{font-size:28px;font-weight:800;letter-spacing:-.01em;margin-bottom:10px}
h1 span{color:var(--red)}
.sub{font-family:var(--mono);font-size:13px;color:var(--text-3);margin-bottom:36px;line-height:1.6}
.meter{background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:8px;height:6px;margin-bottom:28px;overflow:hidden}
.meter-fill{height:100%;border-radius:8px;background:linear-gradient(90deg,var(--amber),var(--red));width:${pct}%}
.stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:32px}
.stat{background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:10px;padding:14px 12px}
.stat-val{font-size:20px;font-weight:700;letter-spacing:-.02em;margin-bottom:4px}
.stat-val.red{color:var(--red)}
.stat-val.amber{color:var(--amber)}
.stat-key{font-family:var(--mono);font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3)}
.note{font-family:var(--mono);font-size:11px;color:var(--text-3);line-height:1.7;
  background:rgba(255,255,255,.02);border:1px solid var(--border);border-radius:8px;padding:14px}
.note code{color:var(--amber)}
</style>
</head>
<body>
<div class="card">
  <div class="icon">⚡</div>
  <h1>Service <span>Suspended</span></h1>
  <p class="sub">This Captura instance has reached its monthly<br/>Railway compute budget and is temporarily offline.</p>
  <div class="meter"><div class="meter-fill"></div></div>
  <div class="stats">
    <div class="stat">
      <div class="stat-val red">$${cost}</div>
      <div class="stat-key">spent</div>
    </div>
    <div class="stat">
      <div class="stat-val amber">$${budg}</div>
      <div class="stat-key">budget</div>
    </div>
    <div class="stat">
      <div class="stat-val">${reqs.toLocaleString()}</div>
      <div class="stat-key">requests</div>
    </div>
  </div>
  <div class="note">
    To resume, call <code>POST /api/admin/reset</code> with a higher<br/>
    <code>newBudget</code> value, or redeploy with <code>BUDGET_USD</code> env var raised.
  </div>
</div>
</body>
</html>`;
}

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(compression());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"],
  }),
);
app.use(
  helmet({
    contentSecurityPolicy: false, // Allow inline scripts in our served HTML
    crossOriginEmbedderPolicy: false,
  }),
);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─── Shutdown middleware ───────────────────────────────────────────────────────
// Must come before rate limiter and routes. Lets /health and /api/stats through.
app.use((req, res, next) => {
  if (!billing.isShutdown()) return next();

  // Always allow health + stats so monitoring still works
  if (
    req.path === "/health" ||
    req.path === "/api/stats" ||
    req.path === "/api/billing"
  ) {
    return next();
  }

  // API calls → JSON error
  if (req.path.startsWith("/api/")) {
    return res.status(503).json({
      error: "Service suspended: monthly budget limit reached.",
      shutdown: true,
    });
  }

  // Browser → full HTML shutdown page
  return res.status(503).send(shutdownPage());
});

// ─── Request logger ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.method === "POST" && req.path.startsWith("/api/")) {
    req._startedAt = Date.now();
    res.on("finish", () => {
      billing.logRequest({
        endpoint: req.path,
        url: req.body?.url || null,
        startedAt: req._startedAt,
        durationMs: Date.now() - req._startedAt,
        statusCode: res.statusCode,
        error: res.statusCode >= 400 ? String(res.statusCode) : null,
      });
    });
  }
  next();
});

// Rate limiter
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: CONFIG.MAX_REQUESTS_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Slow down." },
  skip: (req) => req.path === "/health" || req.path === "/api/stats",
});
app.use("/api", limiter);

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  if (!CONFIG.API_KEY) return next(); // No key configured = open

  const key = req.headers["x-api-key"] || req.query.key;
  if (key !== CONFIG.API_KEY) {
    return res.status(401).json({ error: "Invalid or missing API key." });
  }
  next();
}

// ─── URL Validation ───────────────────────────────────────────────────────────
function validateUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { valid: false, error: "Invalid URL format." };
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return { valid: false, error: "Only http and https URLs are allowed." };
  }

  if (!CONFIG.ALLOW_LOCALHOST) {
    const blocked = [
      "localhost",
      "127.0.0.1",
      "0.0.0.0",
      "::1",
      "10.",
      "192.168.",
      "172.16.",
    ];
    const host = url.hostname.toLowerCase();
    for (const b of blocked) {
      if (host === b || host.startsWith(b)) {
        return { valid: false, error: "Private/local URLs are not allowed." };
      }
    }
  }

  return { valid: true, url: url.href };
}

// ─── Page Setup ───────────────────────────────────────────────────────────────
async function setupPage(
  page,
  { width = 1280, height = 800, userAgent, blockMedia = false } = {},
) {
  await page.setViewport({ width, height, deviceScaleFactor: 1 });

  if (userAgent) {
    await page.setUserAgent(userAgent);
  }

  if (blockMedia) {
    // Block images/fonts/media to speed up scraping
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["image", "media", "font", "stylesheet"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Stats
app.get("/api/stats", authMiddleware, (req, res) => {
  res.json({ ...pool.getStats(), ...billing.getFullStats() });
});

// Billing detail
app.get("/api/billing", authMiddleware, (req, res) => {
  res.json({
    ...billing.getFullStats(),
    history: billing.getBillingHistory(),
    recentRequests: billing.getRecentRequests(),
  });
});

// Admin: reset shutdown + optionally raise budget (requires API key if set)
app.post("/api/admin/reset", authMiddleware, (req, res) => {
  const { newBudget } = req.body || {};
  billing.resetShutdown(newBudget);
  res.json({
    ok: true,
    message: "Shutdown flag cleared.",
    ...billing.getFullStats(),
  });
});

// ── Screenshot ─────────────────────────────────────────────────────────────────
app.post("/api/screenshot", authMiddleware, async (req, res) => {
  const {
    url: rawUrl,
    width = 1280,
    height = 800,
    fullPage = false,
    format = "png", // 'png' | 'jpeg' | 'webp'
    quality = 85, // jpeg/webp only
    waitFor = "networkidle2", // 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'
    waitMs = 0, // Extra wait after load
    userAgent,
    clip, // { x, y, width, height }
    darkMode = false,
    omitBackground = false,
    encoding = "binary", // 'binary' | 'base64'
    selector, // Screenshot a specific element
  } = req.body || {};

  if (!rawUrl) return res.status(400).json({ error: "url is required." });

  const { valid, url, error: urlError } = validateUrl(rawUrl);
  if (!valid) return res.status(400).json({ error: urlError });

  const fmt = ["png", "jpeg", "webp"].includes(format) ? format : "png";
  const w = Math.min(Math.max(parseInt(width) || 1280, 320), 3840);
  const h = Math.min(Math.max(parseInt(height) || 800, 240), 2160);

  try {
    const screenshotBuffer = await pool.withPage(async (page) => {
      await setupPage(page, { width: w, height: h, userAgent });

      if (darkMode) {
        await page.emulateMediaFeatures([
          { name: "prefers-color-scheme", value: "dark" },
        ]);
      }

      await page.goto(url, {
        waitUntil: waitFor,
        timeout: CONFIG.PAGE_TIMEOUT_MS,
      });

      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, Math.min(waitMs, 10000)));
      }

      // Inject scroll hint for lazy-loaded content when fullPage
      if (fullPage) {
        await page.evaluate(async () => {
          await new Promise((resolve) => {
            let scrollTop = 0;
            const interval = setInterval(() => {
              scrollTop += 500;
              window.scrollTo(0, scrollTop);
              if (scrollTop >= document.body.scrollHeight) {
                window.scrollTo(0, 0);
                clearInterval(interval);
                resolve();
              }
            }, 50);
          });
        });
        await new Promise((r) => setTimeout(r, 300));
      }

      const shotOptions = {
        type: fmt,
        fullPage: Boolean(fullPage),
        omitBackground: Boolean(omitBackground),
        encoding: "binary",
        ...(fmt !== "png"
          ? { quality: Math.min(Math.max(parseInt(quality) || 85, 1), 100) }
          : {}),
        ...(clip ? { clip } : {}),
      };

      if (selector) {
        const el = await page.$(selector);
        if (!el) throw new Error(`Element not found: ${selector}`);
        return await el.screenshot(shotOptions);
      }

      return await page.screenshot(shotOptions);
    });

    const mimeTypes = {
      png: "image/png",
      jpeg: "image/jpeg",
      webp: "image/webp",
    };
    const mime = mimeTypes[fmt];

    if (encoding === "base64") {
      return res.json({
        success: true,
        mimeType: mime,
        format: fmt,
        data: screenshotBuffer.toString("base64"),
      });
    }

    res.set("Content-Type", mime);
    res.set("Cache-Control", "no-store");
    res.set("X-Captura-Format", fmt);
    res.send(screenshotBuffer);
  } catch (err) {
    console.error("[Screenshot] Error:", err.message);
    res.status(500).json({ error: err.message || "Screenshot failed." });
  }
});

// ── Scrape ─────────────────────────────────────────────────────────────────────
app.post("/api/scrape", authMiddleware, async (req, res) => {
  const {
    url: rawUrl,
    selector, // CSS selector to extract (default: body)
    waitFor = "domcontentloaded",
    waitMs = 0,
    extractLinks = false,
    extractImages = false,
    extractMeta = true,
    extractText = false, // Return plain text instead of HTML
    blockMedia = true, // Block images/fonts for speed
    userAgent,
    evaluate, // Custom JS to evaluate and return
    width = 1280,
    height = 800,
  } = req.body || {};

  if (!rawUrl) return res.status(400).json({ error: "url is required." });

  const { valid, url, error: urlError } = validateUrl(rawUrl);
  if (!valid) return res.status(400).json({ error: urlError });

  try {
    const result = await pool.withPage(async (page) => {
      await setupPage(page, { width, height, userAgent, blockMedia });

      await page.goto(url, {
        waitUntil: waitFor,
        timeout: CONFIG.PAGE_TIMEOUT_MS,
      });

      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, Math.min(waitMs, 10000)));
      }

      const data = await page.evaluate(
        ({
          selector,
          extractLinks,
          extractImages,
          extractMeta,
          extractText,
          evaluate,
        }) => {
          const title = document.title;
          const canonical =
            document.querySelector('link[rel="canonical"]')?.href || null;

          // HTML / text extraction
          let html = null;
          let text = null;
          const root = selector
            ? document.querySelector(selector)
            : document.body;
          if (!root) return { error: `Selector not found: ${selector}` };

          if (extractText) {
            text = root.innerText || root.textContent;
          } else {
            html = root.outerHTML;
          }

          // Meta tags
          let meta = null;
          if (extractMeta) {
            meta = {};
            document.querySelectorAll("meta").forEach((el) => {
              const name =
                el.getAttribute("name") ||
                el.getAttribute("property") ||
                el.getAttribute("http-equiv");
              const content = el.getAttribute("content");
              if (name && content) meta[name] = content;
            });
          }

          // Links
          let links = null;
          if (extractLinks) {
            links = Array.from(document.querySelectorAll("a[href]"))
              .map((a) => ({
                text: a.innerText.trim().substring(0, 200),
                href: a.href,
              }))
              .filter((l) => l.href.startsWith("http"))
              .slice(0, 500);
          }

          // Images
          let images = null;
          if (extractImages) {
            images = Array.from(document.querySelectorAll("img[src]"))
              .map((img) => ({
                alt: img.alt || "",
                src: img.src,
                width: img.naturalWidth,
                height: img.naturalHeight,
              }))
              .filter((i) => i.src.startsWith("http"))
              .slice(0, 200);
          }

          // Custom evaluate
          let customResult = null;
          if (evaluate) {
            try {
              // eslint-disable-next-line no-eval
              customResult = eval(evaluate);
            } catch (e) {
              customResult = { evalError: e.message };
            }
          }

          return {
            title,
            canonical,
            html,
            text,
            meta,
            links,
            images,
            customResult,
          };
        },
        {
          selector,
          extractLinks,
          extractImages,
          extractMeta,
          extractText,
          evaluate,
        },
      );

      if (data.error) throw new Error(data.error);

      // Add current URL (may differ after redirects)
      data.url = page.url();
      data.statusCode = null; // Puppeteer doesn't expose final status easily here

      return data;
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error("[Scrape] Error:", err.message);
    res.status(500).json({ error: err.message || "Scrape failed." });
  }
});

// ── PDF ────────────────────────────────────────────────────────────────────────
app.post("/api/pdf", authMiddleware, async (req, res) => {
  const {
    url: rawUrl,
    format: pageFormat = "A4",
    printBackground = true,
    landscape = false,
    margin = { top: "1cm", bottom: "1cm", left: "1cm", right: "1cm" },
    waitFor = "networkidle2",
    waitMs = 0,
    encoding = "binary",
  } = req.body || {};

  if (!rawUrl) return res.status(400).json({ error: "url is required." });

  const { valid, url, error: urlError } = validateUrl(rawUrl);
  if (!valid) return res.status(400).json({ error: urlError });

  try {
    const pdfBuffer = await pool.withPage(async (page) => {
      await setupPage(page, { width: 1280, height: 800 });

      await page.goto(url, {
        waitUntil: waitFor,
        timeout: CONFIG.PAGE_TIMEOUT_MS,
      });

      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, Math.min(waitMs, 10000)));
      }

      return await page.pdf({
        format: pageFormat,
        printBackground: Boolean(printBackground),
        landscape: Boolean(landscape),
        margin,
      });
    });

    if (encoding === "base64") {
      return res.json({
        success: true,
        mimeType: "application/pdf",
        data: pdfBuffer.toString("base64"),
      });
    }

    res.set("Content-Type", "application/pdf");
    res.set("Cache-Control", "no-store");
    res.send(pdfBuffer);
  } catch (err) {
    console.error("[PDF] Error:", err.message);
    res.status(500).json({ error: err.message || "PDF generation failed." });
  }
});

// ─── Catch-all serve index.html ───────────────────────────────────────────────
app.get("*", (req, res) => {
  // Shutdown check is already handled by the middleware above;
  // if we reach here the site is up.
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error("[Server] Unhandled error:", err);
  res.status(500).json({ error: "Internal server error." });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║             CAPTURA  —  API Server               ║
╠══════════════════════════════════════════════════╣
║  Port    : ${String(PORT).padEnd(38)}║
║  Auth    : ${(CONFIG.API_KEY ? "Enabled (x-api-key header)" : "Disabled (open)").padEnd(38)}║
║  Limit   : ${String(CONFIG.MAX_REQUESTS_PER_MINUTE + " requests/min").padEnd(38)}║
║  Pages   : ${String("max " + CONFIG.MAX_CONCURRENT_PAGES + " concurrent").padEnd(38)}║
╚══════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[Server] SIGTERM received, closing browser...");
  if (pool.browser) {
    try {
      await pool.browser.close();
    } catch {}
  }
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[Server] SIGINT received, closing browser...");
  if (pool.browser) {
    try {
      await pool.browser.close();
    } catch {}
  }
  process.exit(0);
});
