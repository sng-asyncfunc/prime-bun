import { ensureKernelBun } from "./bootstrap.js";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

try {
	const runtime = await ensureKernelBun();
	console.log(`kernel bun: ${runtime.path}`);
	console.log(`kernel runtime: ${runtime.kernelDirectory}`);
} catch (error) {
	console.error(errorMessage(error));
	process.exit(1);
}
