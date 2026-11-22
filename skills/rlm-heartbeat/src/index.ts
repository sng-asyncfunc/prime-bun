import { requireString, type SkillContext } from "../../_shared/context.ts";

type HeartbeatStatus = "pause" | "resume";
type DeliveryMode = "steer" | "follow_up";

interface ListOptions {
	includeInactive?: boolean;
}

interface CreateOptions {
	interval?: string;
	label?: string;
	deliveryMode?: DeliveryMode;
}

interface UpdateOptions extends CreateOptions {
	instruction?: string;
	status?: HeartbeatStatus;
}

function validateDeliveryMode(value: unknown): asserts value is DeliveryMode | undefined {
	if (value !== undefined && value !== "steer" && value !== "follow_up") {
		throw new TypeError('deliveryMode must be "steer", "follow_up", or undefined');
	}
}

function optionalString(value: unknown, name: string): void {
	if (value !== undefined && typeof value !== "string") {
		throw new TypeError(`${name} must be a string or undefined`);
	}
}

export function createSkill(context: SkillContext) {
	return {
		list: (options: ListOptions = {}) => {
			if (options.includeInactive !== undefined && typeof options.includeInactive !== "boolean") {
				throw new TypeError("includeInactive must be a boolean or undefined");
			}
			return context.hostRequest("rlm_heartbeat.list", {
				include_inactive: options.includeInactive ?? false,
			});
		},
		create: (instruction: string, options: CreateOptions = {}) => {
			requireString(instruction, "instruction");
			optionalString(options.interval, "interval");
			optionalString(options.label, "label");
			validateDeliveryMode(options.deliveryMode);
			return context.hostRequest("rlm_heartbeat.create", {
				instruction,
				...(options.interval === undefined ? {} : { interval: options.interval }),
				...(options.label === undefined ? {} : { label: options.label }),
				...(options.deliveryMode === undefined ? {} : { delivery_mode: options.deliveryMode }),
			});
		},
		update: (id: string, options: UpdateOptions = {}) => {
			requireString(id, "id");
			optionalString(options.instruction, "instruction");
			optionalString(options.interval, "interval");
			optionalString(options.label, "label");
			if (options.status !== undefined && options.status !== "pause" && options.status !== "resume") {
				throw new TypeError('status must be "pause", "resume", or undefined');
			}
			validateDeliveryMode(options.deliveryMode);
			return context.hostRequest("rlm_heartbeat.update", {
				id,
				...(options.instruction === undefined ? {} : { instruction: options.instruction }),
				...(options.interval === undefined ? {} : { interval: options.interval }),
				...(options.label === undefined ? {} : { label: options.label }),
				...(options.status === undefined ? {} : { status: options.status }),
				...(options.deliveryMode === undefined ? {} : { delivery_mode: options.deliveryMode }),
			});
		},
		delete: (id: string) => {
			requireString(id, "id");
			return context.hostRequest("rlm_heartbeat.delete", { id });
		},
	};
}
