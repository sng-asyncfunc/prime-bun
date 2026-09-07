import { describe, expect, it } from "vitest";
import { getPeakOpenRouterPrice } from "../scripts/openrouter-pricing.js";

describe("OpenRouter generated pricing", () => {
	it("uses the highest UTC-window tariff while ignoring unrelated overrides", () => {
		const pricing = {
			prompt: "0.00022",
			completion: "0.00066",
			input_cache_read: "0.000007",
			input_cache_write: "-1",
			overrides: [
				{
					utc_start: 0,
					utc_end: 8,
					prompt: "0.00044",
					completion: "0.00132",
					input_cache_read: "0.000014",
					input_cache_write: "0.0001",
				},
				{ context_length: 1_000_000, prompt: "0.009" },
				{ utc_start: "8", utc_end: 16, prompt: "0.02" },
				{ utc_start: 8, utc_end: 16, prompt: "not-a-price" },
			],
		};

		expect(getPeakOpenRouterPrice(pricing, "prompt")).toBe(440);
		expect(getPeakOpenRouterPrice(pricing, "completion")).toBe(1320);
		expect(getPeakOpenRouterPrice(pricing, "input_cache_read")).toBe(14);
		expect(getPeakOpenRouterPrice(pricing, "input_cache_write")).toBe(100);
	});
});
