import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";

/**
 * macOS's Local Network privacy covers addresses on the Mac's Wi-Fi and
 * Ethernet networks, not VPN tunnels or loopback (Apple's TN3179). Node doesn't
 * report which interfaces can broadcast, so this goes by the interface names
 * macOS gives them.
 */
const BROADCAST_INTERFACE = /^(en|bridge)\d+$/;

const localNetworks = () => {
	const networks = new BlockList();
	for (const [name, addresses] of Object.entries(networkInterfaces())) {
		if (!BROADCAST_INTERFACE.test(name)) continue;
		for (const { family, cidr, internal } of addresses ?? []) {
			if (internal || cidr === null) continue;
			const [network, prefix] = cidr.split("/");
			networks.addSubnet(network, Number(prefix), family === "IPv6" ? "ipv6" : "ipv4");
		}
	}
	return networks;
};

const hostOf = (serverUrl: string) => new URL(serverUrl).hostname.replace(/^\[|\]$/g, "");

const portOf = (serverUrl: string) => {
	const url = new URL(serverUrl);
	return url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
};

/** The server's address when it's on one of this Mac's local networks; null otherwise, or when its name doesn't resolve. */
export const localNetworkAddress = async (serverUrl: string): Promise<string | null> => {
	const host = hostOf(serverUrl);
	try {
		const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
		const networks = localNetworks();
		const local = addresses.find(({ address, family }) => networks.check(address, family === 6 ? "ipv6" : "ipv4"));
		return local?.address ?? null;
	} catch {
		return null;
	}
};

/** Longer than a blocked connection takes to fail, which is at once. */
const PROBE_TIMEOUT_MS = 3_000;

/**
 * Opens a plain TCP connection to the server. macOS fails a blocked app's
 * connection to a local address at once with EHOSTUNREACH, where a server
 * that's down refuses (ECONNREFUSED) or never answers.
 */
export const probeLocalNetwork = (address: string, serverUrl: string) =>
	new Promise<"blocked" | "reachable" | "unreachable">((resolve) => {
		const timer = setTimeout(() => resolve("unreachable"), PROBE_TIMEOUT_MS);
		const settle = (result: "blocked" | "reachable" | "unreachable") => {
			clearTimeout(timer);
			resolve(result);
		};
		Bun.connect({
			hostname: address,
			port: portOf(serverUrl),
			socket: {
				open: (socket) => {
					socket.end();
					settle("reachable");
				},
				data: () => {},
				connectError: (_socket, error) =>
					settle((error as NodeJS.ErrnoException).code === "EHOSTUNREACH" ? "blocked" : "unreachable"),
			},
		}).catch((error: NodeJS.ErrnoException) => settle(error.code === "EHOSTUNREACH" ? "blocked" : "unreachable"));
	});
