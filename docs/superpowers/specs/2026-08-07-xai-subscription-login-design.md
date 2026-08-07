# xAI Subscription Login Design

**Date:** 2026-08-07
**Status:** Approved direction

## Summary

Add xAI subscription authentication to Prime Agent's existing `/login` flow. Users can sign in with a SuperGrok or X Premium account through xAI's OAuth device-code flow. Static `XAI_API_KEY` authentication remains available as a fallback.

## Context

Prime Agent currently exposes xAI models but resolves xAI authentication only from a stored API key, `XAI_API_KEY`, a runtime override, or custom model configuration. Its AI package already has a provider-agnostic OAuth registry, refresh support, credential persistence in `auth.json`, and a terminal login dialog that supports device-code flows.

Warp treats a Grok subscription as a first-class credential: it obtains an OAuth access and refresh token, stores them separately from static keys, refreshes access before expiry, and sends the access token as bearer authentication. Warp uses Authorization Code with PKCE on the fixed Grok callback port and includes a pasted-code fallback. xAI's current OpenID metadata and official Grok Build client also support the OAuth device-code grant, which avoids fixed-port conflicts and works in local, SSH, container, and headless environments.

References:

- [Warp Grok subscription OAuth](https://github.com/warpdotdev/warp/blob/master/crates/ai/src/grok_subscription/oauth.rs)
- [Warp subscription-auth implementation commit](https://github.com/warpdotdev/warp/commit/38703bca723c1f20c185cea1836832ea9f197bd7)
- [xAI OpenID metadata](https://auth.x.ai/.well-known/openid-configuration)
- [Official Grok Build authentication guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md)

## Goals

- Offer "xAI (Grok/X subscription)" as a subscription entry in `/login`.
- Authenticate through xAI's device-code flow without requiring a local callback port.
- Persist and refresh OAuth credentials through the existing `AuthStorage` lifecycle.
- Use the OAuth access token as bearer authentication for existing xAI models.
- Preserve API-key login, `XAI_API_KEY`, runtime overrides, and custom provider configuration.
- Provide cancellation and actionable protocol errors without exposing credentials.

## Non-goals

- Removing or changing xAI API-key support.
- Reading or mutating the official Grok CLI's credential file.
- Adding a second xAI provider ID or duplicating the model catalog.
- Changing model metadata, transport APIs, or the daemon protocol.
- Adding account, team, usage, or subscription-management UI.

## Approaches Considered

### 1. Device-code OAuth in the existing provider registry — selected

Register xAI as another built-in OAuth provider. Request a device code, open xAI's verification URL, poll until approval, and store the resulting access and refresh tokens using the existing credential schema.

This has the smallest integration surface, works with Prime Agent's existing terminal login UI, avoids a fixed callback port, and preserves API-key login as a peer option.

### 2. Warp's fixed-port Authorization Code + PKCE flow

Mirror Warp exactly with `127.0.0.1:56121`, PKCE, CSRF state validation, callback HTML, CORS/Private Network Access handling, and a manual pasted-code race.

This matches Warp's desktop flow but adds a callback server and several failure modes that device authorization avoids. It is less suitable for SSH and container sessions.

### 3. Reuse official Grok Build credentials

Read `~/.grok/auth.json` or shell out to `grok login` and reuse its access token.

This reduces duplicated OAuth code but couples Prime Agent to another program's installation, storage schema, permissions, and token lifecycle. It also makes login behavior environment-dependent.

## Detailed Design

### OAuth provider

Add a built-in `OAuthProviderInterface` implementation with provider ID `xai` and display name `xAI (Grok/X subscription)`.

It uses xAI's public Grok Build client and scopes:

- Client ID: `b1a00492-073a-47ea-816f-4c329264a828`
- Device authorization: `https://auth.x.ai/oauth2/device/code`
- Token endpoint: `https://auth.x.ai/oauth2/token`
- Scopes: `openid profile email offline_access grok-cli:access api:access`

The provider is exported and added to the built-in OAuth registry. Existing registry consumers automatically expose it in the AI package CLI and Prime Agent's `/login` selector.

### Login flow

1. POST a form-encoded device authorization request with the client ID, scopes, and a Prime Agent referrer.
2. Parse and validate `device_code`, `user_code`, `verification_uri`, `expires_in`, optional `interval`, and optional `verification_uri_complete`.
3. Accept only HTTPS verification URLs before passing one to the browser-opening UI. Prefer the complete URL when supplied so the code is prefilled.
4. Show the user code and begin polling only after the server-provided interval. Use five seconds when the interval is absent, invalid, or zero.
5. Handle `authorization_pending`, `slow_down`, denial, expiry, cancellation, malformed responses, and other OAuth errors explicitly.
6. On success, convert the token response to the existing credential shape and let `AuthStorage.login()` persist it atomically.

Cancellation propagates through fetch calls and poll waits via the login dialog's `AbortSignal`.

### Refresh and request authentication

OAuth credentials use the existing fields:

- `access`: current xAI access token
- `refresh`: xAI refresh token
- `expires`: absolute refresh deadline in milliseconds

The refresh deadline is five minutes before the server-reported expiry. If `expires_in` is omitted, assume a one-hour lifetime. Refresh uses the `refresh_token` grant and preserves the previous refresh token if xAI does not rotate it.

`getApiKey()` returns the access token. The existing xAI model catalog already targets `https://api.x.ai/v1`, and the OpenAI-compatible transports already send the resolved key as `Authorization: Bearer ...`, so no model or transport change is needed.

Stored xAI credentials retain the current authentication precedence: runtime `--api-key`, stored credential, `XAI_API_KEY`, then custom fallback. Signing in with a subscription replaces a stored xAI API key, while an explicit runtime override still wins. Selecting xAI's API-key entry later replaces the stored subscription credential.

### User experience

The provider selector shows two xAI entries:

- `xAI (Grok/X subscription)` — secondary label `subscription`
- `xAI` — secondary label `api key`

Selecting the subscription entry opens xAI's verification page and shows the code. The dialog remains cancellable. Success uses the existing login confirmation and credential path messaging. API-key setup remains unchanged.

Documentation states that subscription-backed API access depends on xAI account eligibility and that API-key authentication remains the fallback if xAI rejects inference for a subscription tier.

## Error Handling

- Reject malformed device and token responses with field-specific messages.
- Reject non-HTTPS verification URLs before opening them.
- Treat aborts during requests or waits as `Login cancelled`.
- Respect `authorization_pending` without surfacing an error.
- Increase the interval on `slow_down`, using the server's replacement interval when valid.
- Surface denial and expired-device-code outcomes distinctly.
- Include OAuth error codes and descriptions for other non-success responses, but do not include raw response bodies or credentials.
- Preserve expired credentials when refresh fails so the user can retry `/login`; this matches existing `AuthStorage` behavior.

## Testing

Add focused AI-package tests that fail before the provider exists and cover:

- Built-in registry exposure for provider ID `xai`.
- Device request client ID, scopes, and referrer.
- Waiting before the first poll.
- Pending and `slow_down` polling behavior.
- Default polling when `interval` is zero or absent.
- Preference for `verification_uri_complete`.
- Rejection of non-HTTPS verification URLs.
- Denial, cancellation, malformed response, and upstream error paths.
- Token refresh, refresh-token rotation, and preservation when no rotated token is returned.
- Default expiry and five-minute refresh skew.
- `getApiKey()` returning the OAuth access token.

Run the new focused test file during the red and green TDD phases, then run `npm run check` and resolve every reported error, warning, and informational finding.

## Compatibility

This is backward-compatible. It adds an optional built-in OAuth provider and does not remove credentials, models, commands, or API-key paths. It does not change daemon commands, events, response shapes, protocol version, or capabilities.
