import { describe, expect, it } from "vitest";
import { DEFAULT_IDLE_EVICTION_MINUTES, SettingsManager } from "../src/core/settings-manager.js";

describe("idle eviction defaults", () => {
	it("retires detached worker trees after five minutes by default", () => {
		expect(DEFAULT_IDLE_EVICTION_MINUTES).toBe(5);
		expect(SettingsManager.inMemory().getIdleEvictionMinutes()).toBe(5);
	});

	it("preserves explicit user overrides", () => {
		expect(SettingsManager.inMemory({ idleEvictionMinutes: 30 }).getIdleEvictionMinutes()).toBe(30);
		expect(SettingsManager.inMemory({ idleEvictionMinutes: "off" }).getIdleEvictionMinutes()).toBe("off");
	});
});
