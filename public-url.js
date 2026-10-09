import os from 'node:os';

function isLoopback(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host);
}

function getLanAddress(networkInterfaces = os.networkInterfaces()) {
  for (const addresses of Object.values(networkInterfaces)) {
    for (const address of addresses || []) {
      if (
        address.family === 'IPv4'
        && !address.internal
        && !address.address.startsWith('169.254.')
        && address.address !== '0.0.0.0'
      ) {
        return address.address;
      }
    }
  }
  return '';
}

function replaceLoopbackHost(url, networkInterfaces) {
  if (!isLoopback(url.hostname)) return url;
  const address = getLanAddress(networkInterfaces);
  if (!address) {
    throw new Error('No LAN IPv4 address is available; set APP_URL to a phone-accessible address.');
  }
  url.hostname = address;
  return url;
}

export function resolvePublicUrl(req, {
  configuredUrl = '',
  httpsEnabled = false,
  port = 3000,
  networkInterfaces
} = {}) {
  const configured = String(configuredUrl || '').trim();
  if (configured) {
    let configuredUrlObject;
    try {
      configuredUrlObject = new URL(configured);
    } catch (error) {
      throw new Error('APP_URL must be a valid absolute URL.', { cause: error });
    }
    return replaceLoopbackHost(configuredUrlObject, networkInterfaces).toString().replace(/\/$/, '');
  }

  const forwardedProto = Array.isArray(req?.headers['x-forwarded-proto'])
    ? req.headers['x-forwarded-proto'][0]
    : req?.headers['x-forwarded-proto'];
  const forwardedHost = Array.isArray(req?.headers['x-forwarded-host'])
    ? req.headers['x-forwarded-host'][0]
    : req?.headers['x-forwarded-host'];
  const proto = forwardedProto || (httpsEnabled ? 'https' : 'http');
  const host = forwardedHost || req?.headers.host || `localhost:${port}`;
  const url = new URL(`${proto}://${host}`);
  replaceLoopbackHost(url, networkInterfaces);
  return url.toString().replace(/\/$/, '');
}
