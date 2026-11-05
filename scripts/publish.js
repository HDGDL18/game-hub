// Veröffentlicht Spiele für die Freigabe: kopiert die normalen Builds in den share-Ordner
// und schreibt catalog.json mit Version und SHA-256-Prüfsumme.
// Aufruf: npm run publish
//
// games.json (Host-Liste): je Spiel "id", "title", "description", "icon", "version" und "share"
// (Pfad zur NORMALEN EXE, nie zur Owner-Version).
//
// publish.json (optional): {"githubRepo": "BENUTZER/REPO"}
// Dann werden die EXEs als GitHub-Release hochgeladen (braucht einmal "gh auth login")
// und catalog.json ins Repo-Root geschrieben, damit die Hubs es von GitHub laden können.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const shareDir = path.join(root, 'share');
const games = JSON.parse(fs.readFileSync(path.join(root, 'games.json'), 'utf8'));
const hubPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

let githubRepo = '';
try {
  githubRepo = JSON.parse(fs.readFileSync(path.join(root, 'publish.json'), 'utf8')).githubRepo || '';
} catch { /* ohne publish.json nur lokal */ }

fs.mkdirSync(shareDir, { recursive: true });

function gh(args) {
  return execFileSync('gh', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

// Lädt eine EXE als Release-Datei hoch. Gibt die öffentliche Download-URL zurück.
function uploadRelease(tag, filePath, file) {
  try {
    gh(['release', 'view', tag, '--repo', githubRepo]);
  } catch {
    gh(['release', 'create', tag, '--repo', githubRepo, '--title', tag, '--notes', 'Automatisch veröffentlicht']);
  }
  gh(['release', 'upload', tag, filePath, '--repo', githubRepo, '--clobber']);
  return `https://github.com/${githubRepo}/releases/download/${tag}/${file}`;
}

const catalogGames = [];
for (const g of games) {
  if (!g.share) continue; // Nur Spiele mit Freigabe-Quelle werden verteilt
  if (!fs.existsSync(g.share)) {
    console.error(`FEHLT: ${g.share} (${g.id})`);
    process.exitCode = 1;
    continue;
  }
  const file = `${g.id}.exe`;
  const dest = path.join(shareDir, file);
  fs.copyFileSync(g.share, dest);
  const data = fs.readFileSync(dest);
  const entry = {
    id: g.id,
    title: g.title,
    description: g.description || '',
    icon: g.icon || '🎮',
    version: g.version,
    file,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    size: data.length,
  };
  if (githubRepo) {
    try {
      entry.url = uploadRelease(`${g.id}-${g.version}`, dest, file);
      console.log(`GitHub  ${g.id} ${g.version} hochgeladen`);
    } catch (err) {
      console.error(`GitHub-Upload fehlgeschlagen für ${g.id}: ${err.message}`);
      process.exitCode = 1;
    }
  }
  catalogGames.push(entry);
  console.log(`OK  ${g.id} ${g.version}  (${data.length} Bytes)`);
}

const catalog = { hubVersion: hubPkg.version, games: catalogGames };
const catalogText = JSON.stringify(catalog, null, 2);
fs.writeFileSync(path.join(shareDir, 'catalog.json'), catalogText, 'utf8');
if (githubRepo) fs.writeFileSync(path.join(root, 'catalog.json'), catalogText, 'utf8');
console.log(`catalog.json geschrieben mit ${catalogGames.length} Spiel(en).`);
if (githubRepo) console.log('Jetzt catalog.json committen und pushen, dann ist das Update online.');
