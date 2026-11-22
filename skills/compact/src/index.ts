import { type SkillContext } from "../../_shared/context.ts";

export function createSkill(context: SkillContext) {
	return {
		status: () => context.hostRequest("compact.status"),
		run: (instructions?: string) => {
			if (instructions !== undefined && typeof instructions !== "string") {
				throw new TypeError("instructions must be a string or undefined");
			}
			return context.hostRequest("compact.run", instructions === undefined ? {} : { instructions });
		},
	};
}
