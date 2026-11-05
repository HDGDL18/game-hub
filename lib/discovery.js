// Automatische Erkennung im lokalen Netzwerk.
// Host sendet alle 2 Sekunden ein kurzes Signal per UDP-Broadcast.
// Client hört zu und nimmt den ersten gefundenen Host.
const dgram = require('dgram');

const DISCOVERY_PORT = 7801;
const MAGIC = 'GAMEHUB';

// Host: kündigt sich an, solange er läuft. Gibt eine Stop-Funktion zurück.
function announce({ port, name = 'Game Hub', broadcastAddr = '255.255.255.255', discoveryPort = DISCOVERY_PORT, intervalMs = 2000 }) {
  const sock = dgram.createSocket('udp4');
  sock.bind(() => sock.setBroadcast(true));
  const payload = Buffer.from(JSON.stringify({ magic: MAGIC, port, name }));
  const send = () => sock.send(payload, discoveryPort, broadcastAddr, () => {});
  send();
  const timer = setInterval(send, intervalMs);
  return () => {
    clearInterval(timer);
    try { sock.close(); } catch { /* bereits geschlossen */ }
  };
}

// Client: sucht bis timeoutMs lang nach einem Host. Liefert { address, port, name } oder null.
function findHost({ timeoutMs = 4000, discoveryPort = DISCOVERY_PORT } = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* ignorieren */ }
      resolve(value);
    };
    sock.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString('utf8'));
        if (data.magic === MAGIC && Number.isInteger(data.port)) {
          finish({ address: rinfo.address, port: data.port, name: data.name || 'Game Hub' });
        }
      } catch { /* fremde Pakete ignorieren */ }
    });
    sock.on('error', () => finish(null));
    sock.bind(discoveryPort, () => {
      try { sock.setBroadcast(true); } catch { /* nicht kritisch */ }
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

module.exports = { announce, findHost, DISCOVERY_PORT };
