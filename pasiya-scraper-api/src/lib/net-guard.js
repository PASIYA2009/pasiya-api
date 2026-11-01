// Blocks requests to private / internal addresses (SSRF). Anyone in a public-mode chat can send a link,
// so the server must never fetch localhost, Railway's private network or cloud metadata addresses.
import dns from 'dns/promises';
import net from 'net';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (/^f[cd]/.test(l) || /^fe[89ab]/.test(l)) return true;
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true;
}

export async function assertPublicUrl(input) {
  let u;
  try { u = new URL(String(input)); } catch { throw new Error('Invalid URL.'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http/https links are allowed.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const blocked = new Error('This link points to a private address and was blocked.');
  if (/(^|\.)(localhost|internal|local)$/i.test(host)) throw blocked;
  if (net.isIP(host)) { if (isPrivateIp(host)) throw blocked; return u; }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch { throw new Error('Could not resolve that link.'); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw blocked;
  return u;
}
