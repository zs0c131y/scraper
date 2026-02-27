# CAPTURA — Web Capture API

**Screenshot, scrape HTML, and generate PDFs from any URL** — powered by Puppeteer and deployed on Railway with a memory-optimized browser pool.

## Features

- **Screenshot** — Full-page or viewport, PNG/JPEG/WebP, dark mode, element crops
- **Scrape** — Extract HTML, plain text, links, images, meta tags, or run custom JS
- **PDF** — A4/Letter/A3, landscape, background printing
- **Memory-efficient** — Single shared Chromium instance, idle shutdown, page pooling
- **Beautiful UI** — Served at `/` with history, options, and inline preview

## Deploy to Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template)

1. Push this repo to GitHub
2. Create a new Railway project → **Deploy from GitHub repo**
3. Set environment variables (see `.env.example`)
4. Railway auto-detects `nixpacks.toml` and installs system Chromium deps

## Local development

```bash
npm install
cp .env.example .env
node server.js        # or: npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## API Reference

All endpoints accept `Content-Type: application/json`.  
If `API_KEY` is set, pass it as `x-api-key` header.

### `POST /api/screenshot`

```json
{
  "url": "https://example.com",
  "width": 1280,
  "height": 800,
  "format": "png",
  "fullPage": false,
  "waitFor": "networkidle2",
  "waitMs": 0,
  "darkMode": false,
  "selector": "#main",
  "encoding": "binary"
}
```

Returns: image binary (`Content-Type: image/png`).  
Pass `"encoding": "base64"` to get `{ success, mimeType, data }` JSON instead.

### `POST /api/scrape`

```json
{
  "url": "https://example.com",
  "selector": "article",
  "extractLinks": true,
  "extractImages": false,
  "extractMeta": true,
  "extractText": false,
  "waitFor": "domcontentloaded",
  "evaluate": "document.title"
}
```

Returns: `{ success, title, url, html, meta, links, images, customResult }`

### `POST /api/pdf`

```json
{
  "url": "https://example.com",
  "format": "A4",
  "landscape": false,
  "printBackground": true,
  "waitFor": "networkidle2"
}
```

Returns: PDF binary (`Content-Type: application/pdf`).

### `GET /health`

Returns: `{ status: "ok", timestamp }`

### `GET /api/stats`

Returns: `{ totalRequests, totalErrors, activePages, queueLength, browserAlive, uptimeSeconds }`

## Memory Tips for Railway

| Setting                   | Value                     | RAM impact                                |
| ------------------------- | ------------------------- | ----------------------------------------- |
| `MAX_CONCURRENT_PAGES`    | 1                         | ~300 MB                                   |
| `MAX_CONCURRENT_PAGES`    | 3                         | ~450 MB                                   |
| `IDLE_BROWSER_TIMEOUT_MS` | 60000                     | Kills Chrome after 1 min idle → frees RAM |
| Chrome args               | `--disable-dev-shm-usage` | Prevents OOM crashes in containers        |

Railway's **Hobby** plan gives you 8 GB RAM — plenty for 3 concurrent captures.
