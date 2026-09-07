export type OpenRouterPricingField =
	| "prompt"
	| "completion"
	| "input_cache_read"
	| "input_cache_write";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function nonNegativePrice(value: unknown): number {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : 0;
	return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export function getPeakOpenRouterPrice(pricing: unknown, field: OpenRouterPricingField): number {
	if (!isRecord(pricing)) return 0;

	const candidates = [nonNegativePrice(pricing[field])];
	if (Array.isArray(pricing.overrides)) {
		for (const override of pricing.overrides) {
			if (isRecord(override) && typeof override.utc_start === "number" && Number.isFinite(override.utc_start)) {
				candidates.push(nonNegativePrice(override[field]));
			}
		}
	}

	return Math.max(...candidates) * 1_000_000;
}
