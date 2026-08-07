// Lokal FTP-deploy: laddar upp allt i public/ till din webbserver.
// Läser uppgifter från .env (se .env.example). Kör med:  npm run deploy
//
// Denna fil är bara för MANUELL deploy från din dator. Den automatiska
// dagliga deployen sköts av GitHub Actions (.github/workflows/deploy.yml)
// och använder GitHub Secrets i stället för .env.

import 'dotenv/config';
import { Client } from 'basic-ftp';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localDir = path.join(__dirname, '..', 'public');

const {
  FTP_SERVER,
  FTP_USERNAME,
  FTP_PASSWORD,
  FTP_SERVER_DIR = './',
  FTP_PROTOCOL = 'ftps',
} = process.env;

if (!FTP_SERVER || !FTP_USERNAME || !FTP_PASSWORD) {
  console.error('❌ Saknar FTP-uppgifter. Kopiera .env.example till .env och fyll i dem.');
  process.exit(1);
}

const client = new Client(30_000);
client.ftp.verbose = false;

try {
  console.log(`🔌 Ansluter till ${FTP_SERVER} (${FTP_PROTOCOL}) …`);
  await client.access({
    host: FTP_SERVER,
    user: FTP_USERNAME,
    password: FTP_PASSWORD,
    secure: FTP_PROTOCOL === 'ftps',
  });

  console.log(`📁 Går till servermapp: ${FTP_SERVER_DIR}`);
  await client.ensureDir(FTP_SERVER_DIR);

  console.log(`⬆️  Laddar upp public/ …`);
  await client.uploadFromDir(localDir);

  console.log('✅ Klar! Sidan är uppladdad.');
} catch (err) {
  console.error('❌ Deploy misslyckades:', err.message);
  process.exitCode = 1;
} finally {
  client.close();
}
