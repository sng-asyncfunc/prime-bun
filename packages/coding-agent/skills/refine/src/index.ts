import { type SkillContext } from "../../_shared/context.ts";

interface RefineOptions {
	global?: boolean;
}

export function createSkill(context: SkillContext) {
	return {
		status: () => context.hostRequest("refine.status"),
		run: (instructions?: string, options: RefineOptions = {}) => {
			if (instructions !== undefined && typeof instructions !== "string") {
				throw new TypeError("instructions must be a string or undefined");
			}
			if (options.global !== undefined && typeof options.global !== "boolean") {
				throw new TypeError("global must be a boolean or undefined");
			}
			return context.hostRequest("refine.run", {
				...(instructions === undefined ? {} : { instructions }),
				...(options.global ? { global: true } : {}),
			});
		},
	};
}
