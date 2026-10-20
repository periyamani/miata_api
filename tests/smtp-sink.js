// A minimal SMTP server for tests: it accepts every message and keeps it in memory, so e-mail delivery is tested through
// the real nodemailer transport. Call startSmtpSink() BEFORE anything loads config/env.js (import the app dynamically
// afterwards): it points SMTP_* at itself. Addresses in `rejectRecipients` are refused with 550, to test failures.
import net from 'node:net';

export const inbox = [];
export const rejectRecipients = new Set();

const address = (line) =>
  line
    .slice(line.indexOf(':') + 1)
    .trim()
    .replace(/^<|>$/g, '')
    .toLowerCase();

/** Undo quoted-printable soft line breaks and =XX escapes, so tests can search the text. */
const decodeQuotedPrintable = (s) =>
  s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

const server = net.createServer((socket) => {
  let buffer = '';
  let envelope = { from: null, to: [] };
  let data = null; // collecting message content after DATA
  const reply = (line) => socket.write(`${line}\r\n`);

  reply('220 sink.test ESMTP');
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (data !== null) {
        if (line === '.') {
          const raw = data.join('\r\n');
          const decoded = decodeQuotedPrintable(raw);
          inbox.push({ from: envelope.from, to: envelope.to, raw, text: Buffer.from(decoded, 'latin1').toString('utf8') });
          data = null;
          envelope = { from: null, to: [] };
          reply('250 OK queued');
        } else {
          data.push(line.startsWith('..') ? line.slice(1) : line);
        }
        continue;
      }
      const command = line.slice(0, 4).toUpperCase();
      if (command === 'EHLO' || command === 'HELO') reply('250 sink.test');
      else if (command === 'MAIL') {
        envelope = { from: address(line), to: [] };
        reply('250 OK');
      } else if (command === 'RCPT') {
        const to = address(line);
        if (rejectRecipients.has(to)) reply('550 5.1.1 Mailbox unavailable');
        else {
          envelope.to.push(to);
          reply('250 OK');
        }
      } else if (command === 'DATA') {
        data = [];
        reply('354 End data with <CR><LF>.<CR><LF>');
      } else if (command === 'QUIT') {
        reply('221 Bye');
        socket.end();
      } else reply('250 OK'); // RSET, NOOP
    }
  });
  socket.on('error', () => {});
});

export async function startSmtpSink() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  // dotenv never overrides variables that are already set, so these win over miata-api/.env.
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(server.address().port);
  process.env.SMTP_SECURE = 'false';
  process.env.SMTP_USER = '';
  process.env.SMTP_PASSWORD = '';
  process.env.EMAIL_FROM = 'MIATA <no-reply@miata.test>';
}

export const closeSmtpSink = () => new Promise((resolve) => server.close(resolve));

/** Messages delivered to `email` (the envelope recipient — what the mail server actually delivers to). */
export const mailFor = (email) => inbox.filter((m) => m.to.includes(email.toLowerCase()));
