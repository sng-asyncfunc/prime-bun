import { cpus } from "node:os";
import { Semaphore } from "../../utils/semaphore.js";

// Bun workers start quickly, but a large fan-out still creates subprocess and
// module-loading pressure, so keep startup bounded above the core count.
const DEFAULT_KERNEL_BOOT_CONCURRENCY = Math.min(16, Math.max(4, (cpus().length || 4) * 2));
const MAX_KERNEL_BOOT_CONCURRENCY = 64;

export function resolveKernelBootConcurrency(): number {
	const raw = process.env.PRIME_AGENT_MAX_CONCURRENT_KERNEL_BOOTS;
	const fallback = DEFAULT_KERNEL_BOOT_CONCURRENCY;
	if (raw === undefined || !/^\d+$/.test(raw)) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	// A malformed or out-of-range value (incl. 0, e.g. "00") falls back to the
	// default rather than mis-bounding the gate or throwing at module load.
	if (parsed < 1) {
		return fallback;
	}
	return Math.min(MAX_KERNEL_BOOT_CONCURRENCY, parsed);
}

let kernelBootSemaphore: Semaphore | undefined;

export function withKernelBootPermit<T>(boot: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!kernelBootSemaphore) {
		kernelBootSemaphore = new Semaphore(resolveKernelBootConcurrency());
	}
	return kernelBootSemaphore.run(boot, signal);
}
