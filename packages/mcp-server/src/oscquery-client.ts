/**
 * OSCQuery client for VRChat.
 *
 * VRChat advertises an OSCQuery HTTP server via mDNS (_oscjson._tcp).
 * This module discovers it and fetches the full parameter tree, which
 * gives us parameter names, types, and current values without needing
 * VRChat to broadcast OSC output first.
 */

import { createLogger } from '@vrchat-mcp-osc/utils';
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

/** Start mDNS browsing for VRChat's _oscjson._tcp service. */
export function startDiscovery(): void {
  if (_browser) return;

  _browser = new OSCQueryDiscovery();

  _browser.on('up', (service: { host: string; port: number; name: string }) => {
    if (service.name.startsWith('VRChat-Client-')) {
      logger.info(`Discovered VRChat OSCQuery on ${service.host}:${service.port}`);
      _discoveredPort = service.port;
    }
  });

  _browser.on('down', (service: { name: string }) => {
    if (service.name.startsWith('VRChat-Client-')) {
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

// ── Port scanning fallback ───────────────────────────────────────────────────

async function scanForOscQueryPort(): Promise<number | null> {
  // VRChat picks a random port but it's usually in this range.
  for (let port = 9000; port <= 9100; port++) {
    try {
      const raw = await httpGet(`http://127.0.0.1:${port}/`, 300);
      const parsed = JSON.parse(raw) as OscQueryNode;
      // VRChat's root node always has /avatar/parameters
      if (parsed.CONTENTS?.['avatar']?.CONTENTS?.['parameters']) {
        logger.info(`Found VRChat OSCQuery via port scan at port ${port}`);
        _discoveredPort = port;
        return port;
      }
    } catch {
      // not this port
    }
  }
  return null;
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

/** Resolve OSCQuery port: use mDNS cache, then scan. */
async function resolvePort(): Promise<number | null> {
  if (_discoveredPort !== null) return _discoveredPort;
  return await scanForOscQueryPort();
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
