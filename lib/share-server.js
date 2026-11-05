// Kleiner HTTP-Server für den Host: liefert catalog.json und die freigegebenen Dateien.
// Es werden nur Dateien ausgeliefert, die im Katalog stehen (kein freier Zugriff auf den Ordner).
const http = require('http');
const fs = require('fs');
const path = require('path');

function readCatalog(shareDir) {
  return JSON.parse(fs.readFileSync(path.join(shareDir, 'catalog.json'), 'utf8'));
}

function start({ shareDir, port, host = '0.0.0.0' }) {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      if (url.pathname === '/catalog.json') {
        const body = fs.readFileSync(path.join(shareDir, 'catalog.json'));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
      const m = url.pathname.match(/^\/files\/(.+)$/);
      if (m) {
        const name = path.basename(decodeURIComponent(m[1]));
        const catalog = readCatalog(shareDir);
        const allowed = catalog.games.some((g) => g.file === name);
        const full = path.join(shareDir, name);
        if (!allowed || !fs.existsSync(full)) {
          res.writeHead(404).end('Nicht gefunden');
          return;
        }
        const stat = fs.statSync(full);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size });
        fs.createReadStream(full).pipe(res);
        return;
      }
      res.writeHead(404).end('Nicht gefunden');
    } catch (err) {
      res.writeHead(500).end('Serverfehler');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

module.exports = { start };
