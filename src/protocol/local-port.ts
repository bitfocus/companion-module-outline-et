/** Width of the range of local ports, above the base. */
export const LOCAL_PORT_SPAN = 10000

/**
 * The local UDP port for one turntable, the same at every restart of
 * Companion or of the connection, so that a restart does not take a new
 * connection on the turntable: `base` plus the last two octets of its
 * address (third × 256 + fourth), modulo 10000. With the default base of
 * 20000 the ports stay below the ephemeral ranges of Linux (32768 and up),
 * macOS and Windows (49152 and up); 192.168.1.120 gets 20376.
 *
 * 0, an automatic port, when `base` is 0 or the address is not a plain IPv4
 * address.
 */
export function preferredLocalPort(host: string, base: number): number {
	if (base <= 0) return 0
	const octets = host.split('.')
	if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) return 0
	const port = base + ((Number(octets[2]) * 256 + Number(octets[3])) % LOCAL_PORT_SPAN)
	return port <= 65535 ? port : 0
}
