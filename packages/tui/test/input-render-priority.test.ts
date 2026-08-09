import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, Container, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class LoggedComponent implements Component {
	constructor(
		private readonly name: string,
		private readonly renderLog: string[],
		public text: string,
	) {}

	render(_width: number): string[] {
		this.renderLog.push(this.name);
		return [this.text];
	}

	invalidate(): void {}
}

class LoggedInput extends LoggedComponent {
	focused = false;

	handleInput(data: string): void {
		this.text += data;
	}
}

class SelfUpdatingComponent extends LoggedComponent {
	private requestRender?: () => void;

	setRenderRequester(requestRender: () => void): void {
		this.requestRender = requestRender;
	}

	update(text: string): void {
		this.text = text;
		this.requestRender?.();
	}
}

class SelfUpdatingLines implements Component {
	private requestRender?: () => void;

	constructor(public lines: string[]) {}

	setRenderRequester(requestRender: () => void): void {
		this.requestRender = requestRender;
	}

	update(lines: string[]): void {
		this.lines = lines;
		this.requestRender?.();
	}

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

describe("TUI input render priority", () => {
	it("paints focused input before a pending transcript frame", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const renderLog: string[] = [];
		const transcript = new LoggedComponent("transcript", renderLog, "old response");
		const dock = new Container();
		const input = new LoggedInput("input", renderLog, "> ");

		dock.addChild(input);
		tui.addChild(transcript);
		tui.addChild(dock);
		tui.setFocus(input);
		tui.start();
		await terminal.waitForRender();
		renderLog.length = 0;

		// Let the frame limiter elapse, then race a coalesced stream update with
		// user input. The editor must be the first component rendered.
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		transcript.text = "new streamed response";
		tui.requestRender();
		terminal.sendInput("x");
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
		await terminal.flush();

		assert.strictEqual(renderLog[0], "input");
		assert.ok(
			terminal.getScrollBuffer().some((line) => line.includes("> x")),
			"typed text should be visible",
		);

		await terminal.waitForRender();
		assert.ok(renderLog.includes("transcript"), "the coalesced transcript frame should still render");
		tui.stop();
	});

	it("keeps consecutive input frames off the transcript render path", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const renderLog: string[] = [];
		const transcript = new LoggedComponent("transcript", renderLog, "long response");
		const dock = new Container();
		const input = new LoggedInput("input", renderLog, "> ");

		dock.addChild(input);
		tui.addChild(transcript);
		tui.addChild(dock);
		tui.setFocus(input);
		tui.start();
		await terminal.waitForRender();
		renderLog.length = 0;

		terminal.sendInput("a");
		await terminal.waitForRender();
		terminal.sendInput("b");
		await terminal.waitForRender();

		assert.deepStrictEqual(renderLog, ["input", "input"]);
		assert.ok(
			terminal.getScrollBuffer().some((line) => line.includes("> ab")),
			"all typed text should be visible",
		);
		tui.stop();
	});

	it("coalesces background frames independently from focused input", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const renderLog: string[] = [];
		const transcript = new LoggedComponent("transcript", renderLog, "initial response");
		const input = new LoggedInput("input", renderLog, "> ");

		tui.addChild(transcript);
		tui.addChild(input);
		tui.setFocus(input);
		tui.start();
		await terminal.waitForRender();
		await new Promise<void>((resolve) => setTimeout(resolve, 60));
		renderLog.length = 0;

		for (let frame = 0; frame < 6; frame++) {
			transcript.text = `stream frame ${frame}`;
			tui.requestRenderFor(transcript);
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 5));

		assert.strictEqual(
			renderLog.filter((component) => component === "transcript").length,
			1,
			"clustered background updates should collapse into one frame",
		);
		tui.stop();
	});

	it("coalesces a burst for one component into one scheduler wakeup", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const renderLog: string[] = [];
		const transcript = new LoggedComponent("transcript", renderLog, "initial response");

		tui.addChild(transcript);
		tui.start();
		await terminal.waitForRender();
		await new Promise<void>((resolve) => setTimeout(resolve, 60));

		const originalNextTick = process.nextTick;
		let schedulerWakeups = 0;
		process.nextTick = ((callback: (...args: unknown[]) => void, ...args: unknown[]) => {
			schedulerWakeups += 1;
			Reflect.apply(originalNextTick, process, [callback, ...args]);
		}) as typeof process.nextTick;
		try {
			for (let update = 0; update < 1_000; update++) {
				transcript.text = `stream frame ${update}`;
				tui.requestRenderFor(transcript);
			}
			assert.strictEqual(schedulerWakeups, 1);
		} finally {
			process.nextTick = originalNextTick;
		}

		await terminal.waitForRender();
		tui.stop();
	});

	it("patches changing background components without rendering stable transcript siblings", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const renderLog: string[] = [];
		const stableTranscript = new LoggedComponent("stable", renderLog, "old transcript");
		const liveMessage = new LoggedComponent("live", renderLog, "partial response");
		const status = new LoggedComponent("status", renderLog, "Writing");
		const input = new LoggedInput("input", renderLog, "> ");

		tui.addChild(stableTranscript);
		tui.addChild(liveMessage);
		tui.addChild(status);
		tui.addChild(input);
		tui.setFocus(input);
		tui.start();
		await terminal.waitForRender();
		await new Promise<void>((resolve) => setTimeout(resolve, 60));
		renderLog.length = 0;

		liveMessage.text = "longer partial response";
		status.text = "Writing · 1s";
		tui.requestRenderFor(liveMessage);
		tui.requestRenderFor(status);
		await new Promise<void>((resolve) => setTimeout(resolve, 60));
		await terminal.flush();

		assert.ok(renderLog.includes("live"));
		assert.ok(renderLog.includes("status"));
		assert.ok(!renderLog.includes("stable"), "stable transcript content should remain on its cached frame");
		assert.ok(terminal.getScrollBuffer().some((line) => line.includes("longer partial response")));
		tui.stop();
	});

	it("binds component-owned updates to their targeted render path", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const renderLog: string[] = [];
		const stableTranscript = new LoggedComponent("stable", renderLog, "old transcript");
		const liveMessage = new SelfUpdatingComponent("live", renderLog, "partial response");

		tui.addChild(stableTranscript);
		tui.addChild(liveMessage);
		tui.start();
		await terminal.waitForRender();
		await new Promise<void>((resolve) => setTimeout(resolve, 60));
		renderLog.length = 0;

		liveMessage.update("longer partial response");
		await new Promise<void>((resolve) => setTimeout(resolve, 60));
		await terminal.flush();

		assert.deepStrictEqual(renderLog, ["live"]);
		assert.ok(terminal.getScrollBuffer().some((line) => line.includes("longer partial response")));
		tui.stop();
	});

	it("realigns cached siblings when a targeted component shrinks across equal blank lines", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const liveMessage = new SelfUpdatingLines(["live", ""]);
		const stableSibling = new SelfUpdatingLines(["", "stable"]);

		tui.addChild(liveMessage);
		tui.addChild(stableSibling);
		tui.start();
		await terminal.waitForRender();
		await new Promise<void>((resolve) => setTimeout(resolve, 60));

		liveMessage.update(["live"]);
		await new Promise<void>((resolve) => setTimeout(resolve, 60));
		await terminal.flush();

		assert.deepStrictEqual(terminal.getViewport().slice(0, 4), ["live", "", "stable", ""]);
		tui.stop();
	});

	it("patches a fullscreen transcript component without rendering stable siblings", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const renderLog: string[] = [];
		const transcript = new Container();
		const stableTranscript = new LoggedComponent("stable", renderLog, "old transcript");
		const liveMessage = new SelfUpdatingComponent("live", renderLog, "partial response");
		const input = new LoggedInput("input", renderLog, "> ");

		transcript.addChild(stableTranscript);
		transcript.addChild(liveMessage);
		tui.setFocus(input);
		tui.start();
		tui.enterFullscreen({ scroll: [transcript], dock: input, mouse: false });
		await terminal.waitForRender();
		await new Promise<void>((resolve) => setTimeout(resolve, 60));
		renderLog.length = 0;

		liveMessage.update("longer partial response");
		await new Promise<void>((resolve) => setTimeout(resolve, 60));
		await terminal.flush();

		assert.deepStrictEqual(renderLog, ["live"]);
		assert.ok(terminal.getViewport().some((line) => line.includes("longer partial response")));
		tui.stop();
	});

	it("scrolls the cached fullscreen transcript without rendering collapsed history", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const renderLog: string[] = [];
		const transcript = new Container();
		const input = new LoggedInput("input", renderLog, "> ");

		for (let line = 0; line < 20; line++) {
			transcript.addChild(new LoggedComponent(`history-${line}`, renderLog, `line ${line}`));
		}
		tui.setFocus(input);
		tui.start();
		tui.enterFullscreen({ scroll: [transcript], dock: input, mouse: false });
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[0], "line 13");
		renderLog.length = 0;

		tui.scrollBy(-3);
		await terminal.waitForRender();

		assert.strictEqual(terminal.getViewport()[0], "line 10");
		assert.deepStrictEqual(renderLog, [], "scrolling should reuse the cached collapsed transcript");
		tui.stop();
	});

	it("prioritizes the dock input in fullscreen mode", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const renderLog: string[] = [];
		const transcript = new LoggedComponent("transcript", renderLog, "old response");
		const dock = new Container();
		const input = new LoggedInput("input", renderLog, "> ");

		dock.addChild(input);
		tui.setFocus(input);
		tui.start();
		tui.enterFullscreen({ scroll: [transcript], dock, mouse: false });
		await terminal.waitForRender();
		renderLog.length = 0;

		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		transcript.text = "new streamed response";
		tui.requestRender();
		terminal.sendInput("x");
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
		await terminal.flush();

		assert.strictEqual(renderLog[0], "input");
		assert.ok(
			terminal.getViewport().some((line) => line.includes("> x")),
			"typed text should be visible in the dock",
		);

		await terminal.waitForRender();
		assert.ok(renderLog.includes("transcript"), "the fullscreen transcript should still catch up");
		tui.stop();
	});
});
