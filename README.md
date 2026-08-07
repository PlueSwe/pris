# Fyndguiden — prisjämförelse (skor & Mac-datorer)

En statisk sajt som jämför priser på Hoka Clifton-löparskor och Apple Mac-datorer,
med leverans inom Sverige/EU. Deployas automatiskt till FTP en gång per dygn via GitHub Actions.

## Struktur

```
public/            ← själva sajten (det som laddas upp)
  index.html       ← startsida (front-end)
  skor.html        ← dashboard för löparskor
  datorer.html     ← jämförelse Mac-datorer
scripts/deploy.mjs ← manuell lokal FTP-deploy (npm run deploy)
.github/workflows/deploy.yml ← automatisk daglig deploy
.env.example       ← mall för lokala FTP-uppgifter
```

## 🔑 Steg 1 – Lägg in FTP-uppgifter som GitHub Secrets

Den automatiska deployen behöver dina FTP-uppgifter som **hemligheter** (de hamnar
aldrig i koden – viktigt eftersom repot är publikt). Lägg in dem själv, antingen via
GitHub-webben (**Settings → Secrets and variables → Actions → New repository secret**)
eller med `gh` i terminalen:

```bash
gh secret set FTP_SERVER    --repo PlueSwe/pris   # t.ex. ftp.dindomän.se
gh secret set FTP_USERNAME  --repo PlueSwe/pris
gh secret set FTP_PASSWORD  --repo PlueSwe/pris   # klistras in säkert, syns ej i historiken
```

Valfria inställningar (via **Variables**, inte Secrets — de är inte hemliga):

```bash
gh variable set FTP_SERVER_DIR --repo PlueSwe/pris --body "/public_html/"  # webbroten på servern
gh variable set FTP_PROTOCOL   --repo PlueSwe/pris --body "ftps"           # ftps eller ftp
```

> Om `FTP_SERVER_DIR`/`FTP_PROTOCOL` inte sätts används `./` respektive `ftps`.

## 🚀 Steg 2 – Deploy

- **Automatiskt:** sker vid varje push till `main` och dagligen 05:00 UTC.
- **Manuellt i GitHub:** fliken **Actions → Deploy till FTP → Run workflow**.
- **Manuellt från din dator:**
  ```bash
  cp .env.example .env   # fyll i dina uppgifter
  npm install
  npm run deploy
  ```

## Uppdatera priser

Priserna ligger i `<script>`-datan i `public/skor.html` och `public/datorer.html`.
Ändra värdena där, committa och pusha – så deployas de vid nästa körning
(eller kör den dagliga jobbet manuellt).

---
Byggd med hjälp av Claude Code. FTP-lösenord hanteras enbart av dig via GitHub Secrets / lokal `.env`.
