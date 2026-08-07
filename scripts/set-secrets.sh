#!/usr/bin/env bash
# Kopierar FTP-uppgifterna från .env till GitHub Secrets/Variables
# för repot PlueSwe/pris. Körs av DIG:  bash scripts/set-secrets.sh
# Innehåller inga hemligheter – värdena läses ur din lokala .env.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "❌ .env saknas. Fyll i .env först (se mallen)."
  exit 1
fi

set -a; source .env; set +a

: "${FTP_SERVER:?❌ FTP_SERVER är tomt i .env}"
: "${FTP_USERNAME:?❌ FTP_USERNAME är tomt i .env}"
: "${FTP_PASSWORD:?❌ FTP_PASSWORD är tomt i .env}"

REPO="PlueSwe/pris"

echo "🔑 Lägger in secrets i $REPO …"
gh secret set FTP_SERVER   --repo "$REPO" --body "$FTP_SERVER"
gh secret set FTP_USERNAME --repo "$REPO" --body "$FTP_USERNAME"
gh secret set FTP_PASSWORD --repo "$REPO" --body "$FTP_PASSWORD"

echo "⚙️  Lägger in variabler (ej hemliga) …"
gh variable set FTP_SERVER_DIR --repo "$REPO" --body "${FTP_SERVER_DIR:-./}"
gh variable set FTP_PROTOCOL   --repo "$REPO" --body "${FTP_PROTOCOL:-ftps}"

echo ""
echo "📋 Verifiering (namn, inte värden):"
gh secret list --repo "$REPO"
gh variable list --repo "$REPO"
echo ""
echo "✅ Klart! Säg till Claude att du kört klart, så triggas deployen."
