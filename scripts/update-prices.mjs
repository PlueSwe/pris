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
const SKIP = [/apple\.com/, /ebay\./, /blocket\.se/, /tradera\.com/, /\/search/, /\bq=/, /collections\//, /scandinavianphoto\.se\/dator/];

/* Växelkurser används bara för trendkurvan i skor.html, som lagras i kronor. */
const EUR_SEK = 11.4, GBP_SEK = 13.4;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

const report = { updated: [], unchanged: [], soldOut: [], manual: [], failed: [] };

const lastHit = new Map();

/* Butikerna svarar 429 om man hämtar för snabbt — en paus per domän räcker. */
async function pace(url) {
  const host = new URL(url).host;
  const wait = 4000 - (Date.now() - (lastHit.get(host) || 0));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastHit.set(host, Date.now());
}

async function fetchHtml(url) {
  await pace(url);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA, "accept-language": "sv-SE,sv;q=0.9,en;q=0.8" },
        redirect: "follow",
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 404 || res.status === 410) return { gone: true };
      if (!res.ok) throw new Error("HTTP " + res.status);
      return { html: await res.text(), finalUrl: res.url };
    } catch (err) {
      if (attempt === 1) return { error: err.message };
      await new Promise(r => setTimeout(r, 3000));
    }
  }
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
      const price = node.price ?? node.lowPrice ?? node.highPrice;
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
  return {
    price: Math.min(...pool.map(o => o.price)),
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
      if (!offers.length) offers = await readShopify(url);
      if (match) offers = offers.filter(o => o.name.toLowerCase().includes(match.toLowerCase()));
      const found = summarize(offers, currency);
      if (!found) { report.manual.push(`${label} — ingen läsbar JSON-LD`); continue; }

      /* Skydd mot feltolkning: ett pris som avviker extremt skrivs aldrig in. */
      if (found.price < current / 3 || found.price > current * 3) {
        report.manual.push(`${label} — avvikande pris ${found.price} mot ${current}, kontrollera`);
        continue;
      }

      if (found.soldOut) report.soldOut.push(`${label} — slut i alla ${found.variants} varianter`);

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

  /* Exit 0 även utan ändringar — arbetsflödet avgör själv om det finns något att committa. */
}

run();
