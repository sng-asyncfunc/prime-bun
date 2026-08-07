/**
 * xAI OAuth device authorization flow.
 */

import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const REFRESH_SKEW_MS = 5 * 60 * 1_000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 60 * 60;

type JsonObject = Record<string, unknown>;

type OAuthHttpResponse = {
	ok: boolean;
	status: number;
	body: JsonObject;
};

type XaiDeviceCode = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	expiresIn: number;
	intervalMs: number;
};

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(body: JsonObject, field: string): string {
	const value = body[field];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Invalid xAI OAuth response field: ${field}`);
	}
	return value;
}

function requiredPositiveNumber(body: JsonObject, field: string): number {
	const value = body[field];
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Invalid xAI OAuth response field: ${field}`);
	}
	return value;
}

function validateVerificationUri(value: string): string {
	try {
		const url = new URL(value);
		if (url.protocol !== "https:") {
			throw new Error("Untrusted verification URI");
		}
		return url.toString();
	} catch (error) {
		if (error instanceof Error && error.message === "Untrusted verification URI") {
			throw error;
		}
		throw new Error("Untrusted verification URI");
	}
}

async function postForm(url: string, fields: Record<string, string>, signal?: AbortSignal): Promise<OAuthHttpResponse> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(fields),
			...(signal ? { signal } : {}),
		});
	} catch (error) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}
		throw error;
	}

	let value: unknown;
	try {
		value = await response.json();
	} catch {
		throw new Error(`xAI OAuth returned invalid JSON (HTTP ${response.status})`);
	}

	if (!isJsonObject(value)) {
		throw new Error(`xAI OAuth returned invalid JSON (HTTP ${response.status})`);
	}

	return { ok: response.ok, status: response.status, body: value };
}

function requestFailure(action: string, response: OAuthHttpResponse): Error {
	const error = typeof response.body.error === "string" ? response.body.error : "unknown_error";
	const description =
		typeof response.body.error_description === "string" ? `: ${response.body.error_description}` : "";
	return new Error(`xAI OAuth ${action} failed (HTTP ${response.status}): ${error}${description}`);
}

function parseDeviceCode(body: JsonObject): XaiDeviceCode {
	const deviceCode = requiredString(body, "device_code");
	const userCode = requiredString(body, "user_code");
	const verificationUri = validateVerificationUri(requiredString(body, "verification_uri"));
	const expiresIn = requiredPositiveNumber(body, "expires_in");
	const interval = body.interval;
	const intervalMs =
		typeof interval === "number" && Number.isFinite(interval) && interval > 0
			? interval * 1_000
			: DEFAULT_POLL_INTERVAL_MS;

	let verificationUriComplete: string | undefined;
	if (body.verification_uri_complete !== undefined) {
		verificationUriComplete = validateVerificationUri(requiredString(body, "verification_uri_complete"));
	}

	return {
		deviceCode,
		userCode,
		verificationUri,
		...(verificationUriComplete ? { verificationUriComplete } : {}),
		expiresIn,
		intervalMs,
	};
}

function credentialsFromTokenResponse(body: JsonObject, previousRefreshToken?: string): OAuthCredentials {
	const access = requiredString(body, "access_token");
	const refresh =
		typeof body.refresh_token === "string" && body.refresh_token.length > 0
			? body.refresh_token
			: previousRefreshToken;
	if (!refresh) {
		throw new Error("Invalid xAI OAuth response field: refresh_token");
	}

	const expiresIn =
		typeof body.expires_in === "number" && Number.isFinite(body.expires_in) && body.expires_in > 0
			? body.expires_in
			: DEFAULT_TOKEN_LIFETIME_SECONDS;

	return {
		access,
		refresh,
		expires: Date.now() + expiresIn * 1_000 - REFRESH_SKEW_MS,
	};
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}

		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Login cancelled"));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function requestDeviceCode(signal?: AbortSignal): Promise<XaiDeviceCode> {
	const response = await postForm(
		DEVICE_CODE_URL,
		{
			client_id: CLIENT_ID,
			scope: SCOPE,
			referrer: "prime-agent",
		},
		signal,
	);
	if (!response.ok) {
		throw requestFailure("device authorization", response);
	}
	return parseDeviceCode(response.body);
}

async function pollForTokens(device: XaiDeviceCode, signal?: AbortSignal): Promise<OAuthCredentials> {
	const deadline = Date.now() + device.expiresIn * 1_000;
	let intervalMs = device.intervalMs;

	while (Date.now() < deadline) {
		await abortableSleep(Math.min(intervalMs, deadline - Date.now()), signal);

		const response = await postForm(
			TOKEN_URL,
			{
				grant_type: DEVICE_GRANT_TYPE,
				client_id: CLIENT_ID,
				device_code: device.deviceCode,
			},
			signal,
		);

		if (response.ok) {
			return credentialsFromTokenResponse(response.body);
		}

		const error = response.body.error;
		if (error === "authorization_pending") {
			continue;
		}
		if (error === "slow_down") {
			const serverInterval = response.body.interval;
			intervalMs =
				typeof serverInterval === "number" && Number.isFinite(serverInterval) && serverInterval > 0
					? serverInterval * 1_000
					: intervalMs + DEFAULT_POLL_INTERVAL_MS;
			continue;
		}
		if (error === "access_denied" || error === "authorization_denied") {
			throw new Error("xAI device authorization was denied");
		}
		if (error === "expired_token") {
			throw new Error("xAI device code expired");
		}
		throw requestFailure("device authorization", response);
	}

	throw new Error("xAI device code expired");
}

export async function loginXai(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const device = await requestDeviceCode(callbacks.signal);
	callbacks.onAuth({
		url: device.verificationUriComplete ?? device.verificationUri,
		instructions: `Enter code: ${device.userCode}`,
	});
	return pollForTokens(device, callbacks.signal);
}

export async function refreshXaiToken(refreshToken: string): Promise<OAuthCredentials> {
	const response = await postForm(TOKEN_URL, {
		grant_type: "refresh_token",
		client_id: CLIENT_ID,
		refresh_token: refreshToken,
	});
	if (!response.ok) {
		throw requestFailure("token refresh", response);
	}
	return credentialsFromTokenResponse(response.body, refreshToken);
}

export const xaiOAuthProvider: OAuthProviderInterface = {
	id: "xai",
	name: "xAI (Grok/X subscription)",
	login: loginXai,
	refreshToken: (credentials) => refreshXaiToken(credentials.refresh),
	getApiKey: (credentials) => credentials.access,
};
