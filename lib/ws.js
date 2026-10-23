// Just enough of RFC 6455 for a one-way relay: the handshake, server-to-client
// text frames, and close/ping handling for whatever the client sends.
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_BUFFER = 1e6; // clients never need to send data, so don't hold floods

export function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

// The wallpaper is a file:// page; also allow plain localhost pages.
export function allowOrigin(origin) {
  if (!origin || origin === 'null' || origin.startsWith('file://')) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
}

export function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, payload]);
}

// Takes whole frames off the front of buf and returns them with the rest.
export function parseFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    const maskLen = b1 & 0x80 ? 4 : 0;
    if (buf.length - p < maskLen + len) break;
    const mask = maskLen ? buf.subarray(p, p + 4) : null;
    p += maskLen;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    frames.push({ opcode: b0 & 0x0f, payload });
    off = p + len;
  }
  return [frames, buf.subarray(off)];
}

export class Hub {
  constructor() {
    this.clients = new Set();
  }

  upgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key || !allowOrigin(req.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    socket.write(
      ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(key)}`, '', ''].join('\r\n'),
    );
    socket.setNoDelay(true);
    this.clients.add(socket);
    let rest = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      let frames;
      [frames, rest] = parseFrames(Buffer.concat([rest, chunk]));
      for (const f of frames) {
        if (f.opcode === 0x8) socket.end(frame(0x8, f.payload.subarray(0, 2)));
        else if (f.opcode === 0x9) socket.write(frame(0xa, f.payload));
      }
      if (rest.length > MAX_BUFFER) socket.destroy();
    });
    const drop = () => this.clients.delete(socket);
    socket.on('close', drop);
    socket.on('error', drop);
  }

  broadcast(event) {
    const data = frame(0x1, Buffer.from(JSON.stringify(event)));
    for (const socket of this.clients) if (socket.writable) socket.write(data);
  }
}
