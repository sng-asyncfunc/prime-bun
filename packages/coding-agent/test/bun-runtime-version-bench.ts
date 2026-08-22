/**
 * Compare Prime Bun kernel behavior across Bun runtime versions.
 *
 * Run from packages/coding-agent:
 *
 *   npx tsx test/bun-runtime-version-bench.ts --bun /path/to/bun
 */
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { type ExecuteResult, KernelManager } from "../src/core/kernel/index.js";

const DEFAULT_STARTUP_RUNS = 12;
const DEFAULT_OPERATION_RUNS = 40;
const LONG_SESSION_CELLS = 2_000;

interface Distribution {
	medianMs: number;
	p95Ms: number;
}

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
}

function positiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(sorted: readonly number[], fraction: number): number {
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
	return sorted[index] ?? 0;
}

function distribution(samples: readonly number[]): Distribution {
	const sorted = [...samples].sort((left, right) => left - right);
	return {
		medianMs: percentile(sorted, 0.5),
		p95Ms: percentile(sorted, 0.95),
	};
}

async function timed<T>(operation: () => Promise<T>): Promise<{ elapsedMs: number; value: T }> {
	const startedAt = performance.now();
	const value = await operation();
	return { elapsedMs: performance.now() - startedAt, value };
}

function assertOk(result: ExecuteResult, label: string): void {
	if (result.status !== "ok") {
		throw new Error(`${label} failed: ${result.error?.evalue ?? result.stderr ?? result.status}`);
	}
}

async function sample(manager: KernelManager, label: string, code: string, runs: number): Promise<Distribution> {
	const samples: number[] = [];
	for (let run = 0; run < runs; run += 1) {
		const { elapsedMs, value } = await timed(() => manager.execute(code));
		assertOk(value, label);
		samples.push(elapsedMs);
	}
	return distribution(samples);
}

async function workerRssMiB(manager: KernelManager): Promise<number> {
	const result = await manager.execute("console.log(process.memoryUsage().rss)");
	assertOk(result, "worker RSS probe");
	const bytes = Number(result.stdout.trim());
	if (!Number.isFinite(bytes)) throw new Error(`invalid worker RSS: ${JSON.stringify(result.stdout)}`);
	return bytes / 1024 / 1024;
}

const bunPath = argument("bun") ?? process.env.PRIME_AGENT_KERNEL_BUN ?? "bun";
const startupRuns = positiveInteger(argument("startup-runs"), DEFAULT_STARTUP_RUNS);
const operationRuns = positiveInteger(argument("operation-runs"), DEFAULT_OPERATION_RUNS);
const bunVersion = execFileSync(bunPath, ["--version"], { encoding: "utf8" }).trim();
process.env.PRIME_AGENT_KERNEL_BUN = bunPath;

const startupSamples: number[] = [];
for (let run = 0; run < startupRuns; run += 1) {
	const manager = new KernelManager({ bun: bunPath });
	try {
		const { elapsedMs, value } = await timed(() => manager.execute("1 + 1"));
		assertOk(value, "startup");
		startupSamples.push(elapsedMs);
	} finally {
		await manager.dispose();
	}
}

const manager = new KernelManager({ bun: bunPath });
try {
	assertOk(await manager.execute("1 + 1"), "warmup");
	for (let run = 0; run < 10; run += 1) assertOk(await manager.execute("1 + 1"), "warmup");

	const scalar = await sample(manager, "scalar cell", "1 + 1", operationRuns);
	const output64KiB = await sample(
		manager,
		"64 KiB output",
		'process.stdout.write("x".repeat(65_536))',
		operationRuns,
	);
	const writes10k = await sample(
		manager,
		"10,000 writes",
		'for (let index = 0; index < 10_000; index += 1) process.stdout.write("x")',
		operationRuns,
	);
	const nativeShell = await sample(manager, "native shell", "await $`printf bun-bench`.quiet().text()", operationRuns);

	assertOk(await manager.execute("globalThis.primeBenchBlob = new Uint8Array(32 * 1024 * 1024)"), "large state setup");
	const checkpointSamples: number[] = [];
	for (let run = 0; run < 6; run += 1) {
		const { elapsedMs, value } = await timed(() => manager.execute("1 + 1"));
		assertOk(value, "32 MiB checkpoint");
		checkpointSamples.push(elapsedMs);
		assertOk(await manager.execute(`globalThis.primeBenchBlob[0] = ${run + 1}`), "large state mutation");
	}
	const rssWith32MiBState = await workerRssMiB(manager);
	assertOk(await manager.execute("delete globalThis.primeBenchBlob"), "large state cleanup");
	assertOk(await manager.execute("1 + 1"), "large state cleanup checkpoint");

	assertOk(await manager.execute("globalThis.primeAbortMarker = 17"), "abort state setup");
	assertOk(await manager.execute("1 + 1"), "abort state checkpoint");
	const abortSamples: number[] = [];
	const recoverySamples: number[] = [];
	for (let run = 0; run < 6; run += 1) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 50);
		const aborted = await timed(() => manager.execute("while (true) {}", { signal: controller.signal }));
		clearTimeout(timer);
		if (aborted.value.status !== "aborted") throw new Error(`abort returned ${aborted.value.status}`);
		abortSamples.push(aborted.elapsedMs);

		const recovered = await timed(() => manager.execute("console.log(globalThis.primeAbortMarker)"));
		assertOk(recovered.value, "recovery");
		if (recovered.value.stdout.trim() !== "17") {
			throw new Error(`recovery lost state: ${JSON.stringify(recovered.value.stdout)}`);
		}
		recoverySamples.push(recovered.elapsedMs);
	}

	const rssBeforeLongSession = await workerRssMiB(manager);
	const longSession = await timed(async () => {
		for (let cell = 0; cell < LONG_SESSION_CELLS; cell += 1) {
			assertOk(await manager.execute("1 + 1"), "long-session scalar cell");
		}
	});
	const rssAfterLongSession = await workerRssMiB(manager);

	console.log(
		JSON.stringify(
			{
				bunPath,
				bunVersion,
				operationRuns,
				startupRuns,
				metrics: {
					startup: distribution(startupSamples),
					scalar,
					output64KiB,
					writes10k,
					nativeShell,
					checkpoint32MiB: distribution(checkpointSamples),
					abort: distribution(abortSamples),
					recovery: distribution(recoverySamples),
					longSession: {
						cells: LONG_SESSION_CELLS,
						totalMs: longSession.elapsedMs,
						perCellMs: longSession.elapsedMs / LONG_SESSION_CELLS,
						rssBeforeMiB: rssBeforeLongSession,
						rssAfterMiB: rssAfterLongSession,
						rssGrowthMiB: rssAfterLongSession - rssBeforeLongSession,
					},
					workerRssWith32MiBState: rssWith32MiBState,
				},
			},
			null,
			2,
		),
	);
} finally {
	await manager.dispose();
}
