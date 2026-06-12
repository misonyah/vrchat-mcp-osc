/**
 * OSCQuery client for VRChat.
 *
 * VRChat advertises an OSCQuery HTTP server via mDNS (_oscjson._tcp).
 * This module discovers it and fetches the full parameter tree, which
 * gives us parameter names, types, and current values without needing
 * VRChat to broadcast OSC output first.
 */

import { createLogger } from '@vrchat-mcp-osc/utils';
import { execSync } from 'child_process';
import * as http from 'http';
import { OSCQueryDiscovery } from 'oscquery';

const logger = createLogger('OSCQuery');

export interface OscQueryParameter {
  path: string;         // e.g. /avatar/parameters/IsLocal
  type: string;         // OSCQuery type string: "f", "i", "T"/"F", "N", "s"
  value: unknown;       // current value reported by VRChat
  access: number;       // 1=read, 2=write, 3=readwrite
}

interface OscQueryNode {
  FULL_PATH?: string;
  ACCESS?: number;
  TYPE?: string;
  VALUE?: unknown[];
  CONTENTS?: Record<string, OscQueryNode>;
}

// ── Discovery ────────────────────────────────────────────────────────────────

let _discoveredPort: number | null = null;
let _browser: InstanceType<typeof OSCQueryDiscovery> | null = null;

/** Returns true if the OSCQuery service at address:port is VRChat (has /avatar/parameters). */
async function isVRChatService(address: string, port: number): Promise<boolean> {
  try {
    const raw = await httpGet(`http://${address}:${port}/avatar/parameters`, 1000);
    const node = JSON.parse(raw) as OscQueryNode;
    return node.FULL_PATH === '/avatar/parameters';
  } catch {
    return false;
  }
}

/** Start mDNS browsing for VRChat's _oscjson._tcp service. */
export function startDiscovery(): void {
  if (_browser) return;

  _browser = new OSCQueryDiscovery();

  _browser.on('up', async (service: { address: string; port: number }) => {
    if (_discoveredPort !== null) return; // already found
    if (await isVRChatService(service.address, service.port)) {
      logger.info(`Discovered VRChat OSCQuery at ${service.address}:${service.port}`);
      _discoveredPort = service.port;
    }
  });

  _browser.on('down', async (service: { address: string; port: number }) => {
    if (_discoveredPort === service.port) {
      logger.info('VRChat OSCQuery service went down');
      _discoveredPort = null;
    }
  });

  _browser.start();
  logger.info('OSCQuery mDNS browser started');
}

/** Stop mDNS browsing. */
export function stopDiscovery(): void {
  _browser?.stop();
  _browser = null;
  _discoveredPort = null;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function httpGet(url: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
  });
}

async function fetchOscQueryRoot(port: number): Promise<OscQueryNode> {
  const raw = await httpGet(`http://127.0.0.1:${port}/`);
  return JSON.parse(raw) as OscQueryNode;
}

// ── mDNS wait ────────────────────────────────────────────────────────────────

/**
 * Wait up to `timeoutMs` for mDNS to announce a VRChat OSCQuery service.
 * Returns the port or null if VRChat doesn't appear in time.
 */
async function waitForDiscovery(timeoutMs = 4000): Promise<number | null> {
  // Already know the port — resolve immediately.
  if (_discoveredPort !== null) return _discoveredPort;

  // Check services already found by the browser before we started listening.
  if (_browser) {
    for (const svc of _browser.getServices()) {
      if (await isVRChatService(svc.address, svc.port)) {
        _discoveredPort = svc.port;
        return svc.port;
      }
    }
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      _browser?.off('up', handler);
      logger.warn('VRChat OSCQuery not found via mDNS within timeout');
      resolve(null);
    }, timeoutMs);

    const handler = (service: { host: string; port: number; name: string }) => {
      if (service.name.startsWith('VRChat-Client-')) {
        clearTimeout(timer);
        _browser?.off('up', handler);
        _discoveredPort = service.port;
        resolve(service.port);
      }
    };

    if (!_browser) {
      clearTimeout(timer);
      resolve(null);
      return;
    }

    _browser.on('up', handler);
  });
}

// ── Parameter tree walker ────────────────────────────────────────────────────

function walkNode(node: OscQueryNode, results: OscQueryParameter[]): void {
  if (node.TYPE !== undefined && node.FULL_PATH) {
    results.push({
      path: node.FULL_PATH,
      type: node.TYPE,
      value: Array.isArray(node.VALUE) ? node.VALUE[0] : node.VALUE,
      access: node.ACCESS ?? 0,
    });
  }
  if (node.CONTENTS) {
    for (const child of Object.values(node.CONTENTS)) {
      walkNode(child, results);
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Fast path: find VRChat's listening TCP ports via the OS (no broadcast wait).
 * Works on Windows via PowerShell; returns null on other platforms or if VRChat isn't running.
 */
async function findPortViaProcess(): Promise<number | null> {
  try {
    const pidOut = execSync(
      'powershell -Command "(Get-Process VRChat -ErrorAction SilentlyContinue).Id"',
      { encoding: 'utf8', timeout: 3000 }
    ).trim();
    if (!pidOut) return null;

    const pid = parseInt(pidOut);
    if (isNaN(pid)) return null;

    const portsOut = execSync(
      `powershell -Command "(Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue).LocalPort"`,
      { encoding: 'utf8', timeout: 3000 }
    ).trim();

    const ports = portsOut.split(/\s+/).map(p => parseInt(p)).filter(p => !isNaN(p) && p > 1024);

    for (const port of ports) {
      if (await isVRChatService('127.0.0.1', port)) {
        logger.info(`Found VRChat OSCQuery via process lookup at port ${port}`);
        return port;
      }
    }
  } catch {
    // PowerShell not available or VRChat not running
  }
  return null;
}

/** Resolve OSCQuery port: fast process lookup, then mDNS fallback. */
async function resolvePort(): Promise<number | null> {
  if (_discoveredPort !== null) return _discoveredPort;
  const port = await findPortViaProcess() ?? await waitForDiscovery(3000);
  if (port) _discoveredPort = port;
  return port;
}

/**
 * Fetch all avatar parameters from VRChat via OSCQuery.
 * Returns an empty array if VRChat is not running or OSCQuery is not reachable.
 */
export async function getAvatarParameters(): Promise<OscQueryParameter[]> {
  const port = await resolvePort();
  if (!port) {
    logger.warn('VRChat OSCQuery not found (not running, or OSC disabled)');
    return [];
  }

  try {
    const root = await fetchOscQueryRoot(port);
    const paramsNode = root.CONTENTS?.['avatar']?.CONTENTS?.['parameters'];
    if (!paramsNode) return [];

    const results: OscQueryParameter[] = [];
    walkNode(paramsNode, results);
    return results;
  } catch (err) {
    logger.error(`Failed to fetch OSCQuery parameters: ${err}`);
    return [];
  }
}

/**
 * Fetch current avatar change info from /avatar/change via OSCQuery.
 * Returns null if not available.
 */
export async function getAvatarId(): Promise<string | null> {
  const port = await resolvePort();
  if (!port) return null;

  try {
    const raw = await httpGet(`http://127.0.0.1:${port}/avatar/change`, 2000);
    const node = JSON.parse(raw) as OscQueryNode;
    const val = Array.isArray(node.VALUE) ? node.VALUE[0] : node.VALUE;
    return typeof val === 'string' ? val : null;
  } catch {
    return null;
  }
}
