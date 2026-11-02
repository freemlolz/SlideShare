export async function startDesktopServer(createServer, preferredPort) {
  try { return await createServer({ port: preferredPort }); }
  catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    return createServer({ port: 0 });
  }
}

export function isPresenterUrl(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin && url.pathname === '/host' && !url.search && !url.username && !url.password;
  } catch { return false; }
}

export function isJoinUrl(value, { port, viewerToken, addresses }) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.port === String(port) && addresses.includes(url.hostname)
      && url.pathname === '/join' && !url.search && !url.username && !url.password
      && url.hash === `#token=${viewerToken}`;
  } catch { return false; }
}
