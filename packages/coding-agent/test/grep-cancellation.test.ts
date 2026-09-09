import { getEventListeners } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGrepTool } from "../src/core/tools/grep.ts";
import { ensureTool } from "../src/utils/tools-manager.ts";

vi.mock("../src/utils/tools-manager.ts", () => ({ ensureTool: vi.fn() }));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("grep cancellation", () => {
	let directory: string;
	let controller: AbortController;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-grep-cancellation-"));
		await writeFile(join(directory, "input.txt"), "before\nmatch\nafter\n");
		controller = new AbortController();
		vi.mocked(ensureTool).mockResolvedValue("rg");
	});

	afterEach(async () => {
		vi.resetAllMocks();
		await rm(directory, { recursive: true, force: true });
	});

	it("rejects cancellation during tool discovery before inspecting the search path", async () => {
		vi.mocked(ensureTool).mockImplementation(async () => {
			controller.abort();
			return "rg";
		});
		const isDirectory = vi.fn(() => true);
		const tool = createGrepTool(directory, { operations: { isDirectory, readFile: () => "" } });

		await expect(tool.execute("discovery", { pattern: "match" }, controller.signal)).rejects.toThrow(
			"Operation aborted",
		);
		expect(isDirectory).not.toHaveBeenCalled();
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("rejects cancellation during asynchronous path inspection", async () => {
		const tool = createGrepTool(directory, {
			operations: {
				isDirectory: async () => {
					controller.abort();
					return true;
				},
				readFile: () => "",
			},
		});

		await expect(tool.execute("path", { pattern: "match" }, controller.signal)).rejects.toThrow("Operation aborted");
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("rejects cancellation while reading context after ripgrep exits", async () => {
		const tool = createGrepTool(directory, {
			operations: {
				isDirectory: () => true,
				readFile: async (path) => {
					controller.abort();
					return readFile(path, "utf8");
				},
			},
		});

		await expect(tool.execute("context", { pattern: "match", context: 1 }, controller.signal)).rejects.toThrow(
			"Operation aborted",
		);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("returns context and removes the abort listener after success", async () => {
		const tool = createGrepTool(directory);
		const result = await tool.execute("success", { pattern: "match", context: 1 }, controller.signal);

		expect(result.content).toEqual([
			{ type: "text", text: "input.txt-1- before\ninput.txt:2: match\ninput.txt-3- after" },
		]);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("settles cancellation without waiting for an unfinished path lookup", async () => {
		const started = deferred<void>();
		const lookup = deferred<boolean>();
		const tool = createGrepTool(directory, {
			operations: {
				isDirectory: () => {
					started.resolve();
					return lookup.promise;
				},
				readFile: () => "",
			},
		});
		const result = tool.execute("pending-path", { pattern: "match" }, controller.signal);
		await started.promise;
		controller.abort();
		try {
			await expect(result).rejects.toThrow("Operation aborted");
		} finally {
			lookup.resolve(true);
		}
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("removes the abort listener after a missing search path", async () => {
		const tool = createGrepTool(directory);
		await expect(tool.execute("missing", { pattern: "match", path: "missing" }, controller.signal)).rejects.toThrow(
			"Path not found",
		);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("removes the abort listener when the search process cannot start", async () => {
		vi.mocked(ensureTool).mockResolvedValue(join(directory, "missing-rg"));
		const tool = createGrepTool(directory);
		await expect(tool.execute("spawn-error", { pattern: "match" }, controller.signal)).rejects.toThrow(
			"Failed to run ripgrep",
		);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});
});
