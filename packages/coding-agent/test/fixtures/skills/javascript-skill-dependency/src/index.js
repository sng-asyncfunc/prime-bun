import { fixtureValue } from "prime-agent-fixture-dependency";

export function createSkill() {
	return {
		value() {
			return fixtureValue;
		},
	};
}
