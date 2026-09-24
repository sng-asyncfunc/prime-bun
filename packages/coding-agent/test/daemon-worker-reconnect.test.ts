import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DaemonWorkerClient } from "../src/modes/daemon/daemon-worker-client.js";

it.skipIf(process.platform === "win32")("reconnects the same worker client after a refused connection", async () => {
	const dir = mkdtempSync(join(tmpdir(), "worker-retry-"));
	const path = join(dir, "worker.sock");
	const client = new DaemonWorkerClient(path);
	const server = createServer((socket) => socket.on("error", () => {}));
	try {
		await expect(client.connect()).rejects.toThrow();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(path, resolve);
		});
		await expect(client.connect()).resolves.toBeUndefined();
	} finally {
		client.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(dir, { recursive: true, force: true });
	}
});
