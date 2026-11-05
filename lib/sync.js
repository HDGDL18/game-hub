// Synchronisation: holt den Katalog von der Quelle und lädt fehlende oder
// veraltete Spiele in den lokalen Installationsordner. Reines Node, ohne Electron.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const STATE_FILE = 'state.json';

function getClient(url) {
  return url.startsWith('https:') ? https : http;
}

// GET mit Weiterleitungen (GitHub liefert oft 302). Gibt die Antwort-Stream zurück.
function request(url, redirects = 5, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = getClient(url).get(url, { headers: { 'User-Agent': 'GameHub' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(request(next, redirects - 1, timeoutMs));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} bei ${url}`));
      }
      resolve(res);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Zeitüberschreitung bei ${url}`)));
    req.on('error', reject);
  });
}

async function fetchCatalog(source) {
  const res = await request(source);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  const catalog = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!catalog || !Array.isArray(catalog.games)) throw new Error('Katalog ist ungültig');
  return catalog;
}

// Lädt eine Datei in eine .part-Datei, prüft die SHA-256-Summe und ersetzt dann das Ziel.
async function downloadFile(url, dest, expectedSha256) {
  const res = await request(url);
  const part = dest + '.part';
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(part);
    res.on('data', (chunk) => hash.update(chunk));
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });
  const actual = hash.digest('hex');
  if (expectedSha256 && actual !== expectedSha256.toLowerCase()) {
    fs.rmSync(part, { force: true });
    throw new Error('Prüfsumme stimmt nicht – Download verworfen');
  }
  try {
    fs.renameSync(part, dest);
  } catch (e) {
    fs.rmSync(part, { force: true });
    if (e.code === 'EPERM' || e.code === 'EBUSY') {
      throw new Error('Spiel läuft gerade – Update wird beim nächsten Start übernommen');
    }
    throw e;
  }
}

function readState(installDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(installDir, STATE_FILE), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(installDir, state) {
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, STATE_FILE), JSON.stringify(state, null, 2), 'utf8');
}

// Dateiname aus dem Katalog nur als reiner Name übernehmen (kein Pfad, keine ..).
function safeFileName(name) {
  const base = path.basename(String(name));
  if (!base || base !== name || base.startsWith('.')) throw new Error(`Ungültiger Dateiname: ${name}`);
  return base;
}

// Hauptfunktion. onProgress(id, text) meldet den Fortschritt pro Spiel.
async function syncGames({ source, installDir, onProgress = () => {} }) {
  const catalog = await fetchCatalog(source);
  const state = readState(installDir);
  const results = [];

  for (const game of catalog.games) {
    const file = safeFileName(game.file);
    const target = path.join(installDir, file);
    const installed = state[game.id];
    const needsUpdate = !installed || installed.version !== game.version || !fs.existsSync(target);

    if (!needsUpdate) {
      results.push({ id: game.id, status: 'current', version: game.version });
      continue;
    }

    onProgress(game.id, `Lade ${game.title} ${game.version} …`);
    try {
      fs.mkdirSync(installDir, { recursive: true });
      // Absolute URL im Katalog (z. B. GitHub-Release) hat Vorrang, sonst relativ zur Katalog-Adresse
      const fileUrl = game.url
        ? new URL(game.url, source).toString()
        : new URL('./files/' + encodeURIComponent(file), source).toString();
      await downloadFile(fileUrl, target, game.sha256);
      state[game.id] = { version: game.version, file };
      writeState(installDir, state);
      results.push({ id: game.id, status: 'updated', version: game.version });
    } catch (err) {
      results.push({ id: game.id, status: 'error', version: game.version, error: err.message });
    }
  }

  return { catalogHubVersion: catalog.hubVersion || null, results, games: catalog.games };
}

// Lokaler Zustand ohne Netzwerk: welche Spiele sind schon installiert?
function installedGames(installDir) {
  const state = readState(installDir);
  const out = {};
  for (const [id, info] of Object.entries(state)) {
    const target = path.join(installDir, info.file || '');
    if (info.file && fs.existsSync(target)) out[id] = { version: info.version, file: target };
  }
  return out;
}

module.exports = { syncGames, installedGames, fetchCatalog, downloadFile, safeFileName };
