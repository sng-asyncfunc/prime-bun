import { afterEach, describe, expect, it, vi } from "vitest";
import { getOAuthProvider, resetOAuthProviders } from "../src/utils/oauth/index.js";
import type { OAuthCredentials, OAuthProviderInterface } from "../src/utils/oauth/types.js";

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";

function provider(): OAuthProviderInterface {
	const value = getOAuthProvider("xai");
	expect(value).toBeDefined();
	return value!;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function requestUrl(input: string | URL | Request): string {
	if (input instanceof Request) return input.url;
	return String(input);
}

function requestForm(init?: RequestInit): URLSearchParams {
	return new URLSearchParams(String(init?.body));
}

function deviceCodeResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		device_code: "device-code",
		user_code: "ABCD-1234",
		verification_uri: "https://accounts.x.ai/oauth2/device",
		expires_in: 900,
		interval: 5,
		...overrides,
	};
}

function tokenResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		access_token: "access-token",
		refresh_token: "refresh-token",
		expires_in: 21_600,
		token_type: "Bearer",
		...overrides,
	};
}

async function login(signal = new AbortController().signal): Promise<OAuthCredentials> {
	return provider().login({
		onAuth: () => {},
		onPrompt: async () => "",
		signal,
	});
}

describe("xAI OAuth", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
		resetOAuthProviders();
	});

	it("registers xAI as a built-in subscription provider", () => {
		expect(provider()).toMatchObject({ id: "xai", name: "xAI (Grok/X subscription)" });
	});

	it("requests a device code, waits before polling, and handles pending and slow_down", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-08-07T12:00:00Z");
		vi.setSystemTime(startTime);
		const replies = [
			jsonResponse({ error: "authorization_pending" }, 400),
			jsonResponse({ error: "slow_down", interval: 10 }, 400),
			jsonResponse(tokenResponse()),
		];
		const pollTimes: number[] = [];
		const onAuth = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = requestUrl(input);
				if (url === "https://auth.x.ai/oauth2/device/code") {
					const body = requestForm(init);
					expect(body.get("client_id")).toBe(CLIENT_ID);
					expect(body.get("scope")).toBe(SCOPE);
					expect(body.get("referrer")).toBe("prime-agent");
					return jsonResponse(deviceCodeResponse());
				}

				expect(url).toBe("https://auth.x.ai/oauth2/token");
				pollTimes.push(Date.now());
				const body = requestForm(init);
				expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
				expect(body.get("client_id")).toBe(CLIENT_ID);
				expect(body.get("device_code")).toBe("device-code");
				const reply = replies.shift();
				if (!reply) throw new Error("Unexpected token poll");
				return reply;
			}),
		);

		const loginPromise = provider().login({ onAuth, onPrompt: async () => "" });
		await vi.advanceTimersByTimeAsync(0);
		expect(onAuth).toHaveBeenCalledWith({
			url: "https://accounts.x.ai/oauth2/device",
			instructions: "Enter code: ABCD-1234",
		});
		expect(pollTimes).toEqual([]);

		await vi.advanceTimersByTimeAsync(5_000);
		expect(pollTimes).toEqual([startTime.getTime() + 5_000]);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(pollTimes).toEqual([startTime.getTime() + 5_000, startTime.getTime() + 10_000]);
		await vi.advanceTimersByTimeAsync(10_000);

		await expect(loginPromise).resolves.toEqual({
			access: "access-token",
			refresh: "refresh-token",
			expires: startTime.getTime() + 20_000 + 21_600_000 - 300_000,
		});
	});

	it.each([0, undefined])("uses a five-second default for interval %s", async (interval) => {
		vi.useFakeTimers();
		let requests = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				requests += 1;
				return requests === 1 ? jsonResponse(deviceCodeResponse({ interval })) : jsonResponse(tokenResponse());
			}),
		);

		const loginPromise = login();
		await vi.advanceTimersByTimeAsync(4_999);
		expect(requests).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		await loginPromise;
		expect(requests).toBe(2);
	});

	it("prefers a validated verification_uri_complete", async () => {
		vi.useFakeTimers();
		const onAuth = vi.fn();
		let requests = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				requests += 1;
				return requests === 1
					? jsonResponse(
							deviceCodeResponse({
								verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
							}),
						)
					: jsonResponse(tokenResponse());
			}),
		);

		const loginPromise = provider().login({ onAuth, onPrompt: async () => "" });
		await vi.advanceTimersByTimeAsync(5_000);
		await loginPromise;
		expect(onAuth).toHaveBeenCalledWith({
			url: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
			instructions: "Enter code: ABCD-1234",
		});
	});

	it.each(["http://accounts.x.ai/device", "file:///etc/passwd", "not a url"])(
		"rejects an untrusted verification URL: %s",
		async (verificationUri) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => jsonResponse(deviceCodeResponse({ verification_uri: verificationUri }))),
			);
			await expect(login()).rejects.toThrow("Untrusted verification URI");
		},
	);

	it("rejects an untrusted verification_uri_complete", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse(deviceCodeResponse({ verification_uri_complete: "http://accounts.x.ai/oauth2/device" })),
			),
		);
		await expect(login()).rejects.toThrow("Untrusted verification URI");
	});

	it.each<[string, Record<string, unknown>]>([
		["device_code", { device_code: undefined }],
		["expires_in", { expires_in: 0 }],
	])("rejects a malformed device response field: %s", async (field, overrides) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(deviceCodeResponse(overrides))),
		);
		await expect(login()).rejects.toThrow(`Invalid xAI OAuth response field: ${field}`);
	});

	it("rejects invalid JSON responses", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not-json", { status: 502 })),
		);
		await expect(login()).rejects.toThrow("xAI OAuth returned invalid JSON (HTTP 502)");
	});

	it.each(["access_denied", "authorization_denied"])("surfaces device denial: %s", async (error) => {
		vi.useFakeTimers();
		let requests = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				requests += 1;
				return requests === 1 ? jsonResponse(deviceCodeResponse({ interval: 1 })) : jsonResponse({ error }, 400);
			}),
		);

		const loginPromise = login();
		const assertion = expect(loginPromise).rejects.toThrow("xAI device authorization was denied");
		await vi.advanceTimersByTimeAsync(1_000);
		await assertion;
	});

	it("surfaces an expired device code", async () => {
		vi.useFakeTimers();
		let requests = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				requests += 1;
				return requests === 1
					? jsonResponse(deviceCodeResponse({ interval: 1 }))
					: jsonResponse({ error: "expired_token" }, 400);
			}),
		);

		const loginPromise = login();
		const assertion = expect(loginPromise).rejects.toThrow("xAI device code expired");
		await vi.advanceTimersByTimeAsync(1_000);
		await assertion;
	});

	it("does not poll after the device code deadline", async () => {
		vi.useFakeTimers();
		let requests = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				requests += 1;
				return requests === 1
					? jsonResponse(deviceCodeResponse({ expires_in: 1, interval: 5 }))
					: jsonResponse(tokenResponse());
			}),
		);

		const loginPromise = login();
		const assertion = expect(loginPromise).rejects.toThrow("xAI device code expired");
		await vi.advanceTimersByTimeAsync(1_000);
		await assertion;
		expect(requests).toBe(1);
	});

	it("cancels before the first token poll", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const fetchMock = vi.fn(async () => jsonResponse(deviceCodeResponse()));
		vi.stubGlobal("fetch", fetchMock);

		const loginPromise = provider().login({
			onAuth: () => controller.abort(),
			onPrompt: async () => "",
			signal: controller.signal,
		});

		await expect(loginPromise).rejects.toThrow("Login cancelled");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("refreshes access and preserves an unrotated refresh token", async () => {
		let requests = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				expect(requestUrl(input)).toBe("https://auth.x.ai/oauth2/token");
				const body = requestForm(init);
				expect(body.get("grant_type")).toBe("refresh_token");
				expect(body.get("client_id")).toBe(CLIENT_ID);
				requests += 1;
				if (requests === 1) {
					expect(body.get("refresh_token")).toBe("first");
					return jsonResponse(tokenResponse({ access_token: "new", refresh_token: "rotated" }));
				}
				expect(body.get("refresh_token")).toBe("keep");
				return jsonResponse(tokenResponse({ access_token: "newer", refresh_token: undefined }));
			}),
		);

		const rotated = await provider().refreshToken({ access: "old", refresh: "first", expires: 0 });
		const preserved = await provider().refreshToken({ access: "old", refresh: "keep", expires: 0 });
		expect(rotated).toMatchObject({ access: "new", refresh: "rotated" });
		expect(preserved).toMatchObject({ access: "newer", refresh: "keep" });
		expect(provider().getApiKey(preserved)).toBe("newer");
	});

	it("uses a one-hour lifetime and five-minute skew when expires_in is absent", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-07T12:00:00Z"));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(tokenResponse({ expires_in: undefined }))),
		);

		const credentials = await provider().refreshToken({ access: "old", refresh: "keep", expires: 0 });
		expect(credentials.expires).toBe(Date.now() + 3_600_000 - 300_000);
	});

	it("applies the five-minute skew to the reported lifetime", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-07T12:00:00Z"));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(tokenResponse({ expires_in: 21_600 }))),
		);

		const credentials = await provider().refreshToken({ access: "old", refresh: "keep", expires: 0 });
		expect(credentials.expires).toBe(Date.now() + 21_600_000 - 300_000);
	});

	it("rejects malformed token responses", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(tokenResponse({ access_token: undefined }))),
		);
		await expect(provider().refreshToken({ access: "old", refresh: "keep", expires: 0 })).rejects.toThrow(
			"Invalid xAI OAuth response field: access_token",
		);
	});

	it("surfaces structured OAuth refresh failures", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "invalid_grant", error_description: "refresh token revoked" }, 400)),
		);

		await expect(provider().refreshToken({ access: "old", refresh: "bad", expires: 0 })).rejects.toThrow(
			"xAI OAuth token refresh failed (HTTP 400): invalid_grant: refresh token revoked",
		);
	});
});
