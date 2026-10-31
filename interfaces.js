/**
 * Network interface enumeration and bind planning.
 *
 * Binding by address is fragile: a DHCP lease, a docked laptop or a changed
 * tailnet address invalidates a hand-written `192.168.x.y:8091` and the bridge
 * silently stops serving that network. Binding by *interface name* keeps
 * working because the address is resolved at bind time, on every launch.
 *
 * The two forms coexist: `bind` names interfaces and is preferred, `listen`
 * keeps explicit `host:port` entries for cases no interface name expresses.
 *
 * @module dsh-desktop-web/interfaces
 */

import { networkInterfaces } from 'node:os';

/** Port used when nothing usable is configured. */
export const DEFAULT_PORT = 8091;

/**
 * Whether an interface entry carries an IPv4 address.
 * @param entry - one `os.networkInterfaces()` address record.
 */
const isV4 = (entry) => entry !== undefined && (entry.family === 'IPv4' || entry.family === 4);

/**
 * Enumerate the interfaces that currently hold an IPv4 address.
 *
 * Only IPv4 is reported: the Host's carrier speaks one address family per
 * listener, and mixing both would make a NIC appear twice with no way to tell
 * which one a browser will reach.
 *
 * @returns `{ name, addresses, internal }` per usable interface, loopback last.
 */
export function listInterfaces() {
  const all = networkInterfaces();
  const found = [];
  for (const [name, records] of Object.entries(all)) {
    const addresses = (records ?? []).filter(isV4).map((record) => record.address);
    if (addresses.length === 0) continue;
    const internal = (records ?? []).filter(isV4).every((record) => record.internal === true);
    found.push({ name, addresses, internal });
  }
  // External interfaces first: loopback is always available and rarely the
  // interesting choice, so it should not push a real NIC off the first screen.
  found.sort((left, right) => {
    if (left.internal !== right.internal) return left.internal ? 1 : -1;
    return left.name.localeCompare(right.name);
  });
  return found;
}

/**
 * Resolve interface names into concrete bindings for the current network.
 *
 * A missing or addressless interface is reported instead of throwing: a laptop
 * that booted with Wi-Fi off must still serve the interfaces that do exist, and
 * the Host row must not fail to activate because one NIC is down.
 *
 * @param names - configured interface names.
 * @param port - port to use for every resolved address.
 * @returns `{ bindings, warnings }`; bindings are `{ host, port, interface }`.
 */
export function resolveBindings(names, port) {
  const bindings = [];
  const warnings = [];
  const seen = new Set();
  const available = new Map(listInterfaces().map((entry) => [entry.name, entry]));

  for (const raw of names ?? []) {
    const name = String(raw ?? '').trim();
    if (name === '') continue;
    const entry = available.get(name);
    if (entry === undefined) {
      warnings.push(`interface ${JSON.stringify(name)} is not present or has no IPv4 address`);
      continue;
    }
    for (const address of entry.addresses) {
      const key = `${address}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bindings.push({ host: address, port, interface: name });
    }
  }
  return { bindings, warnings };
}

/**
 * Current addresses of one interface.
 * @param name - interface name.
 * @returns the IPv4 addresses, or an empty list.
 */
export function addressesOf(name) {
  const entry = listInterfaces().find((candidate) => candidate.name === name);
  return entry === undefined ? [] : entry.addresses;
}

/**
 * Which interface currently owns an address.
 *
 * Used to migrate a hand-written `listen` list onto interface names without
 * making the user retype anything.
 * @param address - IPv4 address.
 * @returns the interface name, or undefined.
 */
export function interfaceOfAddress(address) {
  const text = String(address ?? '').trim();
  for (const entry of listInterfaces()) {
    if (entry.addresses.includes(text)) return entry.name;
  }
  return undefined;
}
