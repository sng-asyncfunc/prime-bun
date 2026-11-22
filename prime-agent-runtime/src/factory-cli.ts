import { cliDispatch } from "./factory-spec.ts";

async function main(): Promise<void> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
	}
	const raw = Buffer.concat(chunks).toString("utf8").trim();
	let payload: unknown;
	try {
		payload = raw ? JSON.parse(raw) : {};
	} catch (error) {
		process.stdout.write(
			`${JSON.stringify({
				ok: false,
				errors: [`invalid factory cli JSON payload: ${error instanceof Error ? error.message : String(error)}`],
			})}\n`,
		);
		return;
	}
	const result = cliDispatch(payload);
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

await main();
