// One-time script — generates public/og-image.png and public/favicon.png
// Run with: node generate-og.js
// Requires: npx playwright (or npm install -g playwright)

import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── OG Image HTML (1200 × 630) ────────────────────────────────────────────────
const ogHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; overflow: hidden; background: #0a0a0a; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif;
    display: flex;
    align-items: stretch;
  }

  /* ── Left panel ── */
  .left {
    flex: 0 0 620px;
    padding: 72px 64px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    position: relative;
  }
  .left::before {
    content: '';
    position: absolute;
    left: 0; top: 72px; bottom: 72px;
    width: 4px;
    background: #FC4C02;
    border-radius: 2px;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    background: transparent;
    border: 1.5px solid #333;
    border-radius: 20px;
    padding: 6px 16px;
    margin-bottom: 32px;
    width: fit-content;
  }
  .badge-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #FC4C02;
    flex-shrink: 0;
  }
  .badge span {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #888;
  }
  h1 {
    font-size: 76px;
    font-weight: 800;
    line-height: 1.0;
    letter-spacing: -2px;
    color: #ffffff;
    margin-bottom: 24px;
  }
  h1 em {
    font-style: normal;
    color: #FC4C02;
  }
  .sub {
    font-size: 22px;
    color: #666;
    line-height: 1.5;
    max-width: 440px;
  }
  .url {
    position: absolute;
    bottom: 44px;
    left: 64px;
    font-size: 15px;
    color: #2a2a2a;
    letter-spacing: 0.01em;
  }

  /* ── Right panel ── */
  .right {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 48px 56px 48px 16px;
    gap: 16px;
  }
  .msg {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .bubble {
    padding: 14px 20px;
    border-radius: 16px;
    font-size: 16px;
    line-height: 1.5;
    max-width: 360px;
  }
  .bubble.user {
    background: #FC4C02;
    color: #fff;
    align-self: flex-end;
    border-bottom-right-radius: 4px;
    font-weight: 500;
  }
  .bubble.claude {
    background: #1a1a1a;
    color: #bbb;
    align-self: flex-start;
    border-bottom-left-radius: 4px;
    border: 1px solid #222;
  }
  .bubble.claude strong {
    color: #e0e0e0;
    font-weight: 600;
  }
</style>
</head>
<body>
  <div class="left">
    <div class="badge">
      <div class="badge-dot"></div>
      <span>Claude MCP Connector</span>
    </div>
    <h1>Strava<br><em>for Claude</em></h1>
    <p class="sub">Your training history, available in every Claude conversation.</p>
    <div class="url">187-77-203-66.sslip.io</div>
  </div>

  <div class="right">
    <div class="msg">
      <div class="bubble user">How was my training this week?</div>
      <div class="bubble claude"><strong>Your biggest week in 3 months</strong> — 48 miles with a solid tempo on Tuesday. Recovery is the priority now.</div>
    </div>
    <div class="msg">
      <div class="bubble user">Am I on track for my marathon?</div>
      <div class="bubble claude">Your long run trend looks strong. <strong>Taper starts now</strong> — easy miles and prioritise sleep this week.</div>
    </div>
  </div>
</body>
</html>`;

// ── Favicon HTML (64 × 64) ────────────────────────────────────────────────────
const faviconHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 64px; height: 64px; overflow: hidden; background: transparent; }
  body {
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif;
  }
  .icon {
    width: 64px; height: 64px;
    background: #FC4C02;
    border-radius: 14px;
    display: flex; align-items: center; justify-content: center;
    flex-direction: column;
    gap: 0px;
  }
  .letter {
    font-size: 36px;
    font-weight: 900;
    color: white;
    letter-spacing: -1px;
    line-height: 1;
  }
</style>
</head>
<body>
  <div class="icon">
    <div class="letter">S</div>
  </div>
</body>
</html>`;

const browser = await chromium.launch();

// Generate OG image (1200×630)
const ogPage = await browser.newPage();
await ogPage.setViewportSize({ width: 1200, height: 630 });
await ogPage.setContent(ogHtml, { waitUntil: 'networkidle' });
const ogBuffer = await ogPage.screenshot({ type: 'png' });
writeFileSync(join(__dirname, 'public', 'og-image.png'), ogBuffer);
console.log('✓ public/og-image.png');

// Generate favicon (64×64, then save as PNG — referenced as /favicon.png)
const favPage = await browser.newPage();
await favPage.setViewportSize({ width: 64, height: 64 });
await favPage.setContent(faviconHtml, { waitUntil: 'networkidle' });
const favBuffer = await favPage.screenshot({ type: 'png', omitBackground: true });
writeFileSync(join(__dirname, 'public', 'favicon.png'), favBuffer);
console.log('✓ public/favicon.png');

await browser.close();
console.log('Done.');
