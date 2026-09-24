import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearConfigValueCache,
	resolveConfigValue,
	resolveConfigValueOrThrow,
	resolveConfigValueUncached,
} from "../src/core/resolve-config-value.js";

const VAR = "PRIME_AGENT_TEST_CREDENTIAL_VAR";

describe("resolveConfigValue env fallback", () => {
	beforeEach(() => {
		delete process.env[VAR];
	});
	afterEach(() => {
		delete process.env[VAR];
		clearConfigValueCache();
	});

	it.each(["empty", "failed"])("retries %s shell credentials but caches successful values", (mode) => {
		const script = `${mode === "failed" ? `if (!process.env.${VAR}) process.exit(1);` : ""}process.stdout.write(process.env.${VAR} || '')`;
		const command = `!${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
		expect(resolveConfigValue(command)).toBeUndefined();
		process.env[VAR] = "recovered";
		expect(resolveConfigValue(command)).toBe("recovered");
		process.env[VAR] = "changed";
		expect(resolveConfigValue(command)).toBe("recovered");
	});

	it("uses the env var value when set", () => {
		process.env[VAR] = "secret-value";
		expect(resolveConfigValue(VAR)).toBe("secret-value");
		expect(resolveConfigValueUncached(VAR)).toBe("secret-value");
	});

	it("falls back to the literal string when the env var is unset", () => {
		expect(resolveConfigValue(VAR)).toBe(VAR);
		expect(resolveConfigValue("sk-literal-key")).toBe("sk-literal-key");
	});

	it("treats a set-but-empty env var as a missing credential, not the literal name", () => {
		process.env[VAR] = "";
		expect(resolveConfigValue(VAR)).toBeUndefined();
		expect(resolveConfigValueUncached(VAR)).toBeUndefined();
		expect(() => resolveConfigValueOrThrow(VAR, "test credential")).toThrow("Failed to resolve test credential");
	});
});
