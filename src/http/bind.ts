// ============================================================================
// Local-only bind addresses: loopback or an address assigned to a tailnet interface
// ============================================================================

import { isIP } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

export type Interfaces = Record<string, NetworkInterfaceInfo[] | undefined>;

export function canonicalAddress(address: string): string {
  if (!isIP(address)) return "";
  try { return address.includes(":") ? new URL(`http://[${address}]/`).hostname.slice(1, -1) : address; }
  catch { return ""; }
}

export function isTailnetAddress(address: string): boolean {
  const a = canonicalAddress(address);
  if (isIP(a) === 4) {
    const [first, second] = a.split(".").map(Number);
    return first === 100 && second >= 64 && second <= 127;
  }
  return isIP(a) === 6 && a.startsWith("fd7a:115c:a1e0:");
}

export function validateBindAddress(address: string, interfaces: Interfaces = networkInterfaces()): string {
  const a = canonicalAddress(address);
  if (a === "127.0.0.1" || a === "::1") return a;
  if (isTailnetAddress(a) && Object.values(interfaces).flat().some(i => i && canonicalAddress(i.address) === a)) return a;
  throw new Error("Bind must be loopback or a tailnet address on a local interface.");
}

export function selectBind(bind: string, interfaces: Interfaces = networkInterfaces()): string {
  if (bind === "loopback") return "127.0.0.1";
  if (bind !== "tailnet") throw new Error("Use --bind loopback or --bind tailnet.");
  const address = Object.values(interfaces).flat().find(i => i && isTailnetAddress(i.address))?.address;
  if (!address) throw new Error("No tailnet address exists on a local interface; connect to your private tailnet first.");
  return validateBindAddress(address, interfaces);
}

export function boundHost(address: string, port: number): string {
  return `${address.includes(":") ? `[${address}]` : address}:${port}`;
}

export function hostMatches(host: string | undefined, address: string, port: number): boolean {
  return host === boundHost(address, port);
}
