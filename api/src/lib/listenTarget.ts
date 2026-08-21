// Derives what index.ts should bind the HTTP listener to from
// API_BASE_URL. Only the port comes from that URL - the host is always
// every interface ('0.0.0.0'), regardless of API_BASE_URL's hostname.
//
// API_BASE_URL describes where the API is publicly reachable FROM (see
// docs/RUNBOOK.md's Railway target-port guidance), never what to bind the
// listening socket TO. A PaaS's public hostname is DNS/proxy-routed and is
// never present on any local network interface inside the container, so
// binding to it literally - as this used to do for any API_BASE_URL other
// than the localhost dev default - fails to listen and crashes the process
// on boot. The deep bug hunt found this crashes the server the moment an
// operator follows the RUNBOOK's own advice to set API_BASE_URL to the real
// deployed URL in production. Extracted as its own pure function so that
// invariant - host is always '0.0.0.0' no matter what hostname comes in -
// has a real regression test without needing to boot a server.
export function resolveListenTarget(apiBaseUrl: string): { port: number; host: string } {
  const url = new URL(apiBaseUrl);
  const port = url.port ? Number(url.port) : 3000;
  return { port, host: '0.0.0.0' };
}
