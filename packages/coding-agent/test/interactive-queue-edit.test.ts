import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { QueueSelection } from "../src/modes/interactive/queue-selection.js";

type Harness = {
	queueSelection: QueueSelection;
	connectionQueue: { steering: string[]; followUp: string[] };
	editor: { getText: () => string; setText: (text: string) => void; addToHistory?: (text: string) => void };
	isApplyingQueueSelectionText: boolean;
	pastedImages: Map<number, unknown>;
	updatePendingMessagesDisplay: () => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	ui: { requestRender: () => void };
	agentConnection: {
		mutateQueuedMessage: ReturnType<typeof vi.fn>;
		getQueue: ReturnType<typeof vi.fn>;
		abort?: ReturnType<typeof vi.fn>;
	};
	sessionEventGeneration: number;
	inputSubmissionGeneration: number;
	pendingQueueEdit: symbol | undefined;
	queueMutationChain: Promise<void>;
	enqueueQueueMutation: <T>(run: () => Promise<T>) => Promise<T>;
	applyQueueSelection: (text: string, targetLane: "steering" | "followUp") => Promise<boolean>;
	browseQueueSelection: (direction: -1 | 1) => void;
	moveQueueSelection: (direction: -1 | 1) => void;
	refreshConnectionQueue: () => Promise<void>;
	replaceConnectionQueue: (queue: { steering: string[]; followUp: string[] }) => void;
	setEditorTextFromQueueSelection: (text: string) => void;
	collectQueueReplaceImages: (text: string) => unknown;
};

const proto = InteractiveMode.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;

function createHarness(queue: { steering: string[]; followUp: string[] }, mutateResult = "applied"): Harness {
	let editorText = "";
	return {
		queueSelection: new QueueSelection(),
		connectionQueue: queue,
		editor: {
			getText: () => editorText,
			setText: (text: string) => {
				editorText = text;
			},
			addToHistory: vi.fn(),
		},
		isApplyingQueueSelectionText: false,
		pastedImages: new Map(),
		updatePendingMessagesDisplay: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		ui: { requestRender: vi.fn() },
		agentConnection: {
			mutateQueuedMessage: vi.fn(async () => mutateResult),
			getQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
			abort: vi.fn(async () => {}),
		},
		sessionEventGeneration: 0,
		inputSubmissionGeneration: 0,
		pendingQueueEdit: undefined,
		queueMutationChain: Promise.resolve(),
		enqueueQueueMutation: proto.enqueueQueueMutation,
		applyQueueSelection: proto.applyQueueSelection,
		browseQueueSelection: proto.browseQueueSelection,
		moveQueueSelection: proto.moveQueueSelection,
		refreshConnectionQueue: proto.refreshConnectionQueue,
		replaceConnectionQueue: proto.replaceConnectionQueue,
		setEditorTextFromQueueSelection: proto.setEditorTextFromQueueSelection,
		collectQueueReplaceImages: proto.collectQueueReplaceImages,
	} as unknown as Harness;
}

describe("interactive queued-message editing", () => {
	it("browses into the queue and applies an enter edit as steering", async () => {
		const harness = createHarness({ steering: ["s1"], followUp: ["f1"] });
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		expect(harness.editor.getText()).toBe("f1");

		expect(await harness.applyQueueSelection("f1 edited", "steering")).toBe(true);
		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledWith("followUp", 0, "f1", {
			type: "replace",
			text: "f1 edited",
			images: [],
			lane: "steering",
		});
		expect(harness.editor.getText()).toBe("draft");
		expect(harness.editor.addToHistory).toHaveBeenCalledWith("f1 edited");
	});

	it("applies a follow-up edit and deletes on empty text", async () => {
		const harness = createHarness({ steering: ["s1"], followUp: [] });
		harness.browseQueueSelection(-1);
		await harness.applyQueueSelection("kept follow-up", "followUp");
		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledWith("steering", 0, "s1", {
			type: "replace",
			text: "kept follow-up",
			images: [],
			lane: "followUp",
		});

		harness.connectionQueue = { steering: ["s1"], followUp: [] };
		harness.browseQueueSelection(-1);
		await harness.applyQueueSelection("   ", "steering");
		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenLastCalledWith("steering", 0, "s1", {
			type: "delete",
		});
	});

	it.each(["rejected", "invalid", "unsupported"])(
		"keeps the selection, edit, and stashed draft when mutation is %s",
		async (status) => {
			const harness = createHarness({ steering: ["queued"], followUp: [] }, status);
			harness.editor.setText("draft");
			harness.browseQueueSelection(-1);
			harness.editor.setText("");

			await harness.applyQueueSelection("edited", "steering");

			expect(harness.queueSelection.selected).toEqual({ lane: "steering", index: 0, text: "queued" });
			expect(harness.queueSelection.hasDraft).toBe(true);
			expect(harness.editor.getText()).toBe("edited");
		},
	);

	it("keeps the selection and edit when the request fails", async () => {
		const harness = createHarness({ steering: ["queued"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockRejectedValue(new Error("connection lost"));
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.editor.setText("");

		await expect(harness.applyQueueSelection("edited", "steering")).rejects.toThrow("connection lost");
		expect(harness.queueSelection.selected).toEqual({ lane: "steering", index: 0, text: "queued" });
		expect(harness.queueSelection.hasDraft).toBe(true);
		expect(harness.editor.getText()).toBe("edited");
	});

	it("does not clobber newer typing while a mutation is in flight", async () => {
		let resolveMutation: (status: string) => void = () => {};
		const harness = createHarness({ steering: ["s1"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveMutation = resolve;
				}),
		);
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.editor.setText("");
		const pending = harness.applyQueueSelection("s1 edited", "steering");
		await vi.waitFor(() => expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalled());
		harness.editor.setText("newer typing");
		resolveMutation("rejected");
		await pending;
		expect(harness.editor.getText()).toBe("newer typing");
	});

	it("serializes rapid moves against the optimistic queue mirror", async () => {
		const harness = createHarness({ steering: ["s1", "s2", "s3"], followUp: [] });
		harness.browseQueueSelection(-1);
		harness.moveQueueSelection(-1);
		harness.moveQueueSelection(-1);
		await harness.queueMutationChain;
		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenNthCalledWith(1, "steering", 2, "s3", {
			type: "move",
			direction: -1,
		});
		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenNthCalledWith(2, "steering", 1, "s3", {
			type: "move",
			direction: -1,
		});
		expect(harness.connectionQueue.steering).toEqual(["s3", "s1", "s2"]);
	});

	it("does not double-apply when the queue event lands before the response", async () => {
		const harness = createHarness({ steering: [], followUp: ["dup", "dup"] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(async () => {
			harness.replaceConnectionQueue({ steering: [], followUp: ["dup"] });
			return "applied";
		});
		harness.browseQueueSelection(-1);
		await harness.applyQueueSelection("   ", "followUp");
		expect(harness.connectionQueue).toEqual({ steering: [], followUp: ["dup"] });
	});

	it("restores the draft when the browsed item is consumed externally", async () => {
		const harness = createHarness({ steering: [], followUp: ["queued"] });
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.agentConnection.getQueue.mockResolvedValue({ steering: [], followUp: [] });

		await harness.refreshConnectionQueue();

		expect(harness.queueSelection.isBrowsing).toBe(false);
		expect(harness.editor.getText()).toBe("draft");
	});

	it("does not let an old mutation reset queue browsing in a replacement session", async () => {
		let resolveMutation: (status: string) => void = () => {};
		const harness = createHarness({ steering: ["old queued"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveMutation = resolve;
				}),
		);
		harness.editor.setText("old draft");
		harness.browseQueueSelection(-1);
		harness.editor.setText("");
		const pending = harness.applyQueueSelection("old edited", "steering");
		await vi.waitFor(() => expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalled());

		harness.sessionEventGeneration++;
		harness.pendingQueueEdit = undefined;
		harness.queueSelection.reset();
		harness.connectionQueue = { steering: ["new queued"], followUp: [] };
		harness.editor.setText("new draft");
		harness.browseQueueSelection(-1);
		resolveMutation("applied");
		await pending;

		expect(harness.queueSelection.selected).toEqual({ lane: "steering", index: 0, text: "new queued" });
		expect(harness.editor.getText()).toBe("new queued");
	});

	it("deduplicates repeated image markers", () => {
		const harness = createHarness({ steering: [], followUp: [] });
		harness.pastedImages.set(1, { type: "image", data: "a", mimeType: "image/png" });
		expect(harness.collectQueueReplaceImages("[image #1] then [image #1]")).toEqual([
			{ type: "image", data: "a", mimeType: "image/png" },
		]);
	});
});

describe("interactive interrupt preserves the queue", () => {
	it("aborts without clearing or restoring queued messages", () => {
		const abort = vi.fn(async () => {});
		const harness = {
			traceUploadAllAbortController: undefined,
			sideQuestionEvent: undefined,
			getRetryAttempt: () => 0,
			isAgentCompacting: () => false,
			isBashRunning: () => false,
			isAgentStreaming: () => true,
			agentConnection: { abort },
			showError: vi.fn(),
			editor: { getText: () => "", setText: vi.fn() },
		};
		(proto.interruptOrClearInput as (this: unknown) => void).call(harness);
		expect(abort).toHaveBeenCalledOnce();
		expect(harness.editor.setText).not.toHaveBeenCalled();
	});
});
