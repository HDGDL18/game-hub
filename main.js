const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sync = require('./lib/sync');
const share = require('./lib/share-server');
const discovery = require('./lib/discovery');

// settings.json (pro PC): role, source, port, installDir, localPaths
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const DEFAULT_SETTINGS = {
  role: 'client',          // 'host' = stellt Spiele bereit, 'client' = holt sie
  source: '',              // z. B. http://192.168.178.20:7800/catalog.json (später GitHub-URL)
  port: 7800,              // Port des Host-Servers
  installDir: '',          // leer = %LOCALAPPDATA%\GameHub\Spiele
  localPaths: {},          // optional: eigener Startpfad je Spiel-ID (z. B. Owner-Version)
};

function loadSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { /* keine Datei = Standard */ }
  const merged = { ...DEFAULT_SETTINGS, ...s, localPaths: { ...(s.localPaths || {}) } };
  if (!merged.installDir) {
    merged.installDir = path.join(process.env.LOCALAPPDATA || app.getPath('home'), 'GameHub', 'Spiele');
  }
  return merged;
}

const settings = loadSettings();
const SHARE_DIR = path.join(__dirname, 'share');
const HUB_GAMES_FILE = path.join(__dirname, 'games.json');
let mainWindow = null;
let shareServer = null;
let stopAnnounce = null;
let activeSource = settings.source || '';

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// Lokale Spieleliste für den Host (games.json mit Freigabe-Quellen)
function hostGames() {
  try { return JSON.parse(fs.readFileSync(HUB_GAMES_FILE, 'utf8')); } catch { return []; }
}

function gameStatus() {
  const installed = sync.installedGames(settings.installDir);

  if (settings.role === 'host') {
    return hostGames().map((g) => {
      const local = settings.localPaths[g.id];
      const ok = local && fs.existsSync(local);
      return {
        id: g.id, title: g.title, description: g.description || '', icon: g.icon || '🎮',
        version: g.version || '', installedVersion: g.version || '',
        status: ok ? 'lokal' : 'nicht-gefunden', launchable: !!ok,
        path: ok ? local : '',
      };
    });
  }

  // Client: Spiele aus dem zuletzt bekannten Katalog plus lokal installierte
  const cache = readCatalogCache();
  const list = cache.games.map((g) => {
    const inst = installed[g.id];
    const current = inst && inst.version === g.version;
    return {
      id: g.id, title: g.title, description: g.description || '', icon: g.icon || '🎮',
      version: g.version, installedVersion: inst ? inst.version : '',
      status: current ? 'aktuell' : inst ? 'update' : 'fehlt',
      launchable: !!inst, path: inst ? inst.file : '',
    };
  });
  // Offline installierte Spiele, die im Katalog gerade fehlen
  for (const [id, inst] of Object.entries(installed)) {
    if (!list.find((g) => g.id === id)) {
      list.push({ id, title: id, description: 'Nicht im aktuellen Katalog', icon: '🎮',
        version: inst.version, installedVersion: inst.version, status: 'aktuell',
        launchable: true, path: inst.file });
    }
  }
  return list;
}

const CATALOG_CACHE = () => path.join(settings.installDir, 'catalog-cache.json');

function readCatalogCache() {
  try { return { games: JSON.parse(fs.readFileSync(CATALOG_CACHE(), 'utf8')).games || [] }; }
  catch { return { games: [] }; }
}

function writeCatalogCache(games) {
  fs.mkdirSync(settings.installDir, { recursive: true });
  fs.writeFileSync(CATALOG_CACHE(), JSON.stringify({ games }, null, 2), 'utf8');
}

// Quelle bestimmen: feste Adresse aus settings.json, sonst automatisch im Netzwerk suchen.
async function resolveSource() {
  if (activeSource) {
    try {
      await sync.fetchCatalog(activeSource);
      return activeSource;
    } catch { /* Quelle antwortet nicht, neu suchen */ }
  }
  const host = await discovery.findHost({ timeoutMs: 4000 });
  if (!host) return null;
  activeSource = `http://${host.address}:${host.port}/catalog.json`;
  return activeSource;
}

async function runSync() {
  if (settings.role !== 'client') {
    return { ok: false, error: 'Dieser PC ist Host und lädt keine Spiele.' };
  }
  const source = await resolveSource();
  if (!source) {
    return { ok: false, error: 'Kein Host im Netzwerk gefunden. Ist der Game Hub auf dem Host-PC geöffnet?' };
  }
  try {
    const res = await sync.syncGames({
      source,
      installDir: settings.installDir,
      onProgress: (id, text) => send('hub:progress', text),
    });
    writeCatalogCache(res.games);
    const errors = res.results.filter((r) => r.status === 'error');
    return {
      ok: errors.length === 0,
      summary: `${res.results.filter((r) => r.status === 'updated').length} aktualisiert, ` +
               `${res.results.filter((r) => r.status === 'current').length} aktuell`,
      errors: errors.map((e) => `${e.id}: ${e.error}`),
    };
  } catch (err) {
    return { ok: false, error: `Host nicht erreichbar: ${err.message}` };
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    title: 'Game Hub',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

ipcMain.handle('hub:info', () => ({
  role: settings.role,
  source: activeSource,
  port: settings.port,
  installDir: settings.installDir,
}));

ipcMain.handle('hub:list', () => gameStatus());

ipcMain.handle('hub:sync', async () => {
  const result = await runSync();
  return { ...result, games: gameStatus() };
});

ipcMain.handle('hub:launch', async (_event, id) => {
  const game = gameStatus().find((g) => g.id === id);
  if (!game || !game.launchable || !game.path) {
    return { ok: false, error: 'Spiel ist noch nicht installiert. Zuerst "Aktualisieren".' };
  }
  const err = await shell.openPath(game.path);
  return err ? { ok: false, error: err } : { ok: true };
});

ipcMain.handle('hub:openFolder', (_event, id) => {
  const game = gameStatus().find((g) => g.id === id);
  if (game && game.path && fs.existsSync(game.path)) shell.showItemInFolder(game.path);
});

app.whenReady().then(async () => {
  if (settings.role === 'host') {
    try {
      shareServer = await share.start({ shareDir: SHARE_DIR, port: settings.port });
      stopAnnounce = discovery.announce({ port: settings.port, name: `Game Hub (${os.hostname()})` });
      console.log(`Host läuft auf Port ${settings.port} und meldet sich im Netzwerk`);
    } catch (err) {
      console.error('Host-Server konnte nicht starten:', err.message);
    }
  }
  createWindow();
  // Client: beim Start automatisch synchronisieren, Fenster zeigt das Ergebnis
  if (settings.role === 'client') {
    runSync().then((r) => send('hub:synced', r));
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (stopAnnounce) stopAnnounce();
  if (shareServer) shareServer.close();
  if (process.platform !== 'darwin') app.quit();
});
