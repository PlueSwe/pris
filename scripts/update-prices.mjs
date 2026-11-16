#!/usr/bin/env node
/**
 * Daglig prisuppdatering utan AI.
 *
 * Läser butikssidornas JSON-LD (schema.org Product/Offer), jämför med priset som
 * står i datablocken i public/*.html och skriver in det nya priset, lägger en punkt
 * i trendkurvan och flaggar slutsålda rader.
 *
 * Körs av .github/workflows/priser.yml varje natt — GitHub-körarna har öppet nät.
 * Kan även köras lokalt:  node scripts/update-prices.mjs [--dry]
 *
 * Rader som inte går att läsa automatiskt (konfiguratorer, eBay-annonser, sök-
 * länkar, kategorisidor) hoppas över och listas i rapporten som "manuell".
 */
import { readFileSync, writeFileSync } from "node:fs";

const DRY = process.argv.includes("--dry");
const TODAY = new Date().toISOString().slice(0, 10);
const FILES = ["public/skor.html", "public/datorer.html", "public/galaxybook.html", "public/golf.html"];

/* Sidor som inte är en enskild produktsida — priset går inte att läsa säkert. */
const SKIP = [
  /apple\.com/, /ebay\./, /blocket\.se/, /tradera\.com/, /\/search/, /\bq=/, /collections\//,
  /scandinavianphoto\.se\/dator/,
  /runnea\.com/,          // listar alla butikers priser för alla varianter på samma sida
  /out-of-bounds\.se/,    // flera kvalitetsklasser och packstorlekar på samma sida
  /par71\.de/,            // anger pris i euro, medan golfsidan lagrar kronor
  /lakeballs\.de/,
];

/* Växelkurser används bara för trendkurvan i skor.html, som lagras i kronor. */
const EUR_SEK = 11.4, GBP_SEK = 13.4;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/* Flera butiker svarar 403/429 på en naken fetch men släpper igenom en begäran som
   ser ut att komma från Chrome. Hela uppsättningen headers behövs — utan sec-fetch
   och sec-ch-ua blockerar t.ex. XXL, Intersport och NJGolf. */
const HEADERS = {
  "user-agent": UA,
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "sv-SE,sv;q=0.9,en-US;q=0.8,en;q=0.7",
  "sec-ch-ua": '"Chromium";v="141", "Not=A?Brand";v="24", "Google Chrome";v="141"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
};

/* Butiker bakom brandvägg som kräver en riktig webbläsare (Playwright). */
const NEEDS_BROWSER = [/elgiganten\.se/, /inet\.se/, /proshop\.se/];

/* Butiker där priset bara finns i HTML-metataggar, inte i JSON-LD. Läggs till
   per butik först när den är kontrollerad för hand — en metatagg på en sida med
   flera varianter kan annars peka på en billigare variant än radens. */
const META_OK = [/njgolf\.se/, /vigliettisport\.com/];

/* Butiker som lägger priset i en inbäddad JSON-klump i stället för JSON-LD.
   Används bara när sidan innehåller exakt ett pris, så att rekommenderade
   produkter längre ner på sidan inte kan förväxlas med varan. */
const JSON_PRICE_OK = [/xxl\.se/];

const report = { updated: [], unchanged: [], soldOut: [], manual: [], failed: [] };

const lastHit = new Map();
let browser = null;

/* Butikerna svarar 429 om man hämtar för snabbt — en paus per domän räcker. */
async function pace(url) {
  const host = new URL(url).host;
  const wait = 4000 - (Date.now() - (lastHit.get(host) || 0));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastHit.set(host, Date.now());
}

/* Startas bara om någon rad behöver den, och återanvänds sedan. */
async function getBrowser() {
  if (browser === null) {
    try {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ args: ["--disable-blink-features=AutomationControlled"] });
    } catch (err) {
      browser = false;
      console.error("Playwright saknas eller gick inte att starta: " + err.message);
    }
  }
  return browser;
}

async function fetchViaBrowser(url) {
  const b = await getBrowser();
  if (!b) return { error: "ingen webbläsare tillgänglig" };
  let page;
  try {
    const ctx = await b.newContext({ userAgent: UA, locale: "sv-SE", viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (res && (res.status() === 404 || res.status() === 410)) return { gone: true };
    await page.waitForTimeout(2500);
    return { html: await page.content(), via: "webbläsare" };
  } catch (err) {
    return { error: "webbläsare: " + err.message.split("\n")[0].slice(0, 60) };
  } finally {
    if (page) await page.context().close().catch(() => {});
  }
}

async function fetchHtml(url, allowBrowser = true) {
  if (allowBrowser && NEEDS_BROWSER.some(re => re.test(url))) return fetchViaBrowser(url);
  await pace(url);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, redirect: "follow", signal: AbortSignal.timeout(25000) });
      if (res.status === 404 || res.status === 410) return { gone: true };
      if (!res.ok) throw new Error("HTTP " + res.status);
      return { html: await res.text(), finalUrl: res.url };
    } catch (err) {
      /* Sista utvägen för en blockerad sida är en riktig webbläsare. */
      if (attempt === 2) return allowBrowser ? await fetchViaBrowser(url) : { error: err.message };
      await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
    }
  }
}

/* Pris ur HTML-metataggar, för butiker utan JSON-LD. */
function readMetaPrice(html, url) {
  if (JSON_PRICE_OK.some(re => re.test(url))) {
    const priser = [...new Set([...html.matchAll(/"price"\s*:\s*(\d+(?:\.\d+)?)/g)].map(m => Number(m[1])))];
    if (priser.length !== 1) return [];
    const iLager = /"stockStatus"\s*:\s*"(?:INSTOCK|LOWSTOCK)"/.test(html);
    return [{ price: priser[0], currency: "SEK", availability: iLager ? "InStock" : "OutOfStock", name: "" }];
  }
  if (!META_OK.some(re => re.test(url))) return [];
  const found = new Set();
  for (const re of [/<meta[^>]+(?:product:price:amount|og:price:amount)[^>]+content="([\d.,]+)"/gi,
                    /itemprop="price"[^>]*content="([\d.,]+)"/gi]) {
    for (const m of html.matchAll(re)) found.add(Number(m[1].replace(/\s/g, "").replace(",", ".")));
  }
  const prices = [...found].filter(n => Number.isFinite(n) && n > 0);
  /* Flera olika metapriser = sidan har varianter, och då vet vi inte vilken som är radens. */
  if (prices.length !== 1) return [];
  const soldOut = /utg[åa]ngen|slutsåld|ej i lager|OutOfStock/i.test(html);
  return [{ price: prices[0], currency: "SEK", availability: soldOut ? "OutOfStock" : "InStock", name: "" }];
}

/* Plockar ut alla erbjudanden ur sidans JSON-LD. */
function readOffers(html) {
  const blocks = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  const offers = [];
  const walk = (node, name = null) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(n => walk(n, name));
    const type = [].concat(node["@type"] || []);
    if (typeof node.name === "string") name = node.name;
    if (type.some(t => /Offer/.test(t))) {
      const price = node.price ?? node.lowPrice ?? node.priceSpecification?.price
                 ?? node.priceSpecification?.["@list"]?.[0]?.price ?? node.highPrice;
      if (price != null && price !== "") {
        offers.push({
          price: Number(String(price).replace(/\s/g, "").replace(",", ".")),
          currency: node.priceCurrency || null,
          availability: String(node.availability || "").replace(/^.*\//, ""),
          name: name || "",
        });
      }
    }
    for (const key of ["@graph", "offers", "hasVariant", "itemListElement", "item", "mainEntity"]) walk(node[key], name);
  };
  for (const block of blocks) {
    try { walk(JSON.parse(block[1].trim())); } catch { /* trasig JSON-LD — hoppa över */ }
  }
  return offers.filter(o => Number.isFinite(o.price) && o.price > 0);
}

/* Shopify-butiker (Swegolf, Plikt Golf m.fl.) lämnar ut produktdata som JSON i
   stället för JSON-LD — både för en produktsida och för en hel kategorisida. */
async function readShopify(url) {
  const api = /\/collections\//.test(url) ? url.replace(/\/?$/, "") + "/products.json?limit=250"
            : /\/products\//.test(url) ? url.replace(/\/?$/, "") + ".json"
            : null;
  if (!api) return [];
  const res = await fetchHtml(api);
  if (!res.html) return [];
  let data;
  try { data = JSON.parse(res.html); } catch { return []; }
  const products = data.products || (data.product ? [data.product] : []);
  return products.flatMap(p => (p.variants || []).map(v => ({
    price: Number(v.price),
    currency: "SEK",
    availability: v.available ? "InStock" : "OutOfStock",
    name: p.title || "",
  })));
}

/* Mest restriktiva tolkningen vinner: finns ingen variant i lager är raden slut. */
function summarize(offers, currency) {
  const matching = currency ? offers.filter(o => !o.currency || o.currency === currency) : offers;
  if (!matching.length) return null;
  const inStock = matching.filter(o => /InStock|LimitedAvailability/i.test(o.availability) && !/OutOf/i.test(o.availability));
  const known = matching.filter(o => o.availability);
  const pool = inStock.length ? inStock : matching;

  /* Vanligaste priset, inte det lägsta. En produktsida med storleksvarianter har
     samma pris om och om igen, medan ett enstaka lägre pris nästan alltid är ett
     medlems-, student- eller delbetalningspris som inte gäller alla (Elgiganten
     visar t.ex. både 22 990 kr och medlemspriset 18 392 kr). Lika många av varje
     pris: ta det högre, det är det man faktiskt betalar. */
  const antal = new Map();
  for (const o of pool) antal.set(o.price, (antal.get(o.price) || 0) + 1);
  const vanligast = [...antal.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];

  return {
    price: vanligast,
    inStock: inStock.length,
    variants: matching.length,
    soldOut: known.length > 0 && inStock.length === 0,
    preOrder: known.length > 0 && known.every(o => /PreOrder/i.test(o.availability)),
  };
}

/* Lägger dagens punkt i en trendkurva, aldrig två punkter samma dag. */
function appendPoint(histSrc, sek) {
  if (histSrc.includes(`["${TODAY}"`)) return histSrc;
  return histSrc.replace(/\]$/, `,["${TODAY}",${Math.round(sek)}]]`);
}

async function run() {
  for (const file of FILES) {
    const original = readFileSync(file, "utf8");
    const lines = original.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const url = line.match(/url:"([^"]+)"/)?.[1];
      if (!url) continue;

      const field = line.match(/\b(price|priceEur|priceGbp|priceSek):\s*([\d.]+)/);
      if (!field) continue;                                   // rad utan pris — inget att uppdatera
      const shop = (line.match(/shop:"([^"]+)"/) || line.match(/name:"([^"]+)"/) || [, url])[1];
      const label = `${file.replace("public/", "")} · ${shop}`;

      /* auto:"..." pekar ut rätt produkt på en kategorisida och gör den läsbar ändå. */
      const match = line.match(/auto:"([^"]+)"/)?.[1];
      if (!match && SKIP.some(re => re.test(url))) { report.manual.push(label); continue; }

      /* Två rader med samma länk (t.ex. medlemspris och ordinarie) går inte att skilja åt. */
      if (!match && lines.filter(l => l.includes(`url:"${url}"`)).length > 1) {
        report.manual.push(`${label} — flera rader delar samma länk`);
        continue;
      }

      const [, fieldName, currentRaw] = field;
      const current = Number(currentRaw);
      const currency = fieldName === "priceEur" ? "EUR" : fieldName === "priceGbp" ? "GBP" : "SEK";

      const res = await fetchHtml(url);
      if (res.gone) { report.soldOut.push(`${label} — sidan borta (404)`); continue; }
      if (res.error) { report.failed.push(`${label} — ${res.error}`); continue; }

      let offers = readOffers(res.html);
      if (!offers.length) offers = readMetaPrice(res.html, url);
      if (!offers.length) offers = await readShopify(url);
      if (match) offers = offers.filter(o => o.name.toLowerCase().includes(match.toLowerCase()));
      const found = summarize(offers, currency);
      if (!found) { report.manual.push(`${label} — ingen läsbar JSON-LD`); continue; }

      /* Skydd mot feltolkning. Ett enskilt steg på mer än 30 % är nästan alltid en
         felläsning, och utan den gränsen kan ett pris vandra bort över flera nätter
         utan att någon enskild körning ser fel (Runnea gick så från 105 till 20 €). */
      const change = Math.abs(found.price - current) / current;
      if (change > 0.30) {
        report.manual.push(`${label} — läste ${found.price} mot ${current} (${Math.round(change * 100)} % skillnad), skrivs inte in`);
        continue;
      }

      /* Är varan slut behålls det senaste priset — ett pris på en slutsåld vara är
         inget fynd, och butikerna visar ofta kvarvarande varianter eller strukna priser. */
      if (found.soldOut) {
        report.soldOut.push(`${label} — slut i alla ${found.variants} varianter, priset lämnas orört`);
        continue;
      }

      const rounded = currency === "SEK" ? Math.round(found.price) : Math.round(found.price * 100) / 100;
      if (rounded === current) { report.unchanged.push(label); continue; }

      let updated = line.replace(new RegExp(`\\b${fieldName}:\\s*[\\d.]+`), `${fieldName}:${rounded}`);
      const sek = currency === "EUR" ? rounded * EUR_SEK : currency === "GBP" ? rounded * GBP_SEK : rounded;
      updated = updated.replace(/hist:(\[\[[^\]]*\](?:,\[[^\]]*\])*\])/, (m, hist) => "hist:" + appendPoint(hist, sek));
      lines[i] = updated;
      report.updated.push(`${label}: ${current} → ${rounded} ${currency}`);

      /* skor.html lagrar trenden separat i SEED, med dom-fältet som nyckel. */
      const dom = line.match(/dom:"([^"]+)"/)?.[1];
      if (dom) {
        const seedIdx = lines.findIndex(l => l.startsWith(`  "${dom}":`));
        if (seedIdx >= 0) lines[seedIdx] = lines[seedIdx].replace(/(\[\[.*\])/, m => appendPoint(m, sek));
      }
    }

    const next = lines.join("\n");
    if (next !== original && !DRY) writeFileSync(file, next);
  }

  const lines = [];
  const section = (title, items) => { if (items.length) lines.push(`\n${title}:`, ...items.map(s => "  - " + s)); };
  section("ÄNDRADE PRISER", report.updated);
  section("SLUT I LAGER — kontrollera om raden ska tas bort", report.soldOut);
  section("KRÄVER MANUELL KONTROLL", report.manual);
  section("GICK INTE ATT HÄMTA", report.failed);
  lines.push(`\nOförändrade: ${report.unchanged.length} rader. Körningen gjord ${TODAY}${DRY ? " (torrkörning)" : ""}.`);
  console.log(lines.join("\n"));

  if (browser) await browser.close();

  /* Exit 0 även utan ändringar — arbetsflödet avgör själv om det finns något att committa. */
}

run();
