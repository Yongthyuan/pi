import { getEventListeners } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import * as childProcess from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGrepTool } from "../src/core/tools/grep.ts";
import type * as ToolsManager from "../src/utils/tools-manager.ts";
import { ensureTool } from "../src/utils/tools-manager.ts";

vi.mock("../src/utils/tools-manager.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof ToolsManager>();
	return { ...actual, ensureTool: vi.fn(actual.ensureTool) };
});
vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

// Regression coverage for #9388: cancellation must cover setup and context reads too.
describe("grep cancellation", () => {
	let directory: string;
	let controller: AbortController;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-grep-cancellation-"));
		await writeFile(join(directory, "input.txt"), "before\nmatch\nafter\n");
		controller = new AbortController();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.resetAllMocks();
		await rm(directory, { recursive: true, force: true });
	});

	it("rejects an already aborted signal without discovering ripgrep", async () => {
		controller.abort();
		await expect(
			createGrepTool(directory).execute("aborted", { pattern: "match" }, controller.signal),
		).rejects.toThrow("Operation aborted");
		expect(ensureTool).not.toHaveBeenCalled();
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
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(childProcess.spawn).not.toHaveBeenCalled();
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

	it("settles cancellation while tool discovery is still pending", async () => {
		const discovery = deferred<string>();
		vi.mocked(ensureTool).mockReturnValue(discovery.promise);
		const isDirectory = vi.fn(() => true);
		const tool = createGrepTool(directory, { operations: { isDirectory, readFile: () => "" } });
		const result = tool.execute("pending-discovery", { pattern: "match" }, controller.signal);
		controller.abort();
		try {
			await expect(result).rejects.toThrow("Operation aborted");
		} finally {
			discovery.resolve("rg");
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(isDirectory).not.toHaveBeenCalled();
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("settles cancellation during a pending context read without reading later matches", async () => {
		await writeFile(join(directory, "other.txt"), "match\n");
		const started = deferred<void>();
		const contents = deferred<string>();
		const readContext = vi.fn(() => {
			started.resolve();
			return contents.promise;
		});
		const tool = createGrepTool(directory, { operations: { isDirectory: () => true, readFile: readContext } });
		const result = tool.execute("pending-context", { pattern: "match", context: 1 }, controller.signal);
		await started.promise;
		controller.abort();
		try {
			await expect(result).rejects.toThrow("Operation aborted");
		} finally {
			contents.resolve("match\n");
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(readContext).toHaveBeenCalledTimes(1);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it.each([false, true])("waits for child closure on abort (match limit reached: %s)", async (reachLimit) => {
		const child = new childProcess.ChildProcess();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		child.stdout = stdout;
		child.stderr = stderr;
		const kill = vi.spyOn(child, "kill").mockImplementation(() => {
			Object.defineProperty(child, "killed", { value: true, configurable: true });
			return true;
		});
		const spawned = deferred<void>();
		vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
			spawned.resolve();
			return child;
		});
		const tool = createGrepTool(directory);
		const result = tool.execute("running", { pattern: "match", limit: 1 }, controller.signal);
		let settled = false;
		void result.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await spawned.promise;
		try {
			if (reachLimit) {
				stdout.write(
					`${JSON.stringify({
						type: "match",
						data: { path: { text: join(directory, "input.txt") }, line_number: 2, lines: { text: "match\n" } },
					})}\n`,
				);
			}
			controller.abort();
			expect(kill).toHaveBeenCalledTimes(1);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(settled).toBe(false);
		} finally {
			child.emit("close", null, "SIGTERM");
			stdout.destroy();
			stderr.destroy();
		}
		await expect(result).rejects.toThrow("Operation aborted");
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("keeps a match-limit result successful without cancellation", async () => {
		const result = await createGrepTool(directory).execute(
			"limit",
			{ pattern: "match", limit: 1 },
			controller.signal,
		);
		expect(result.details?.matchLimitReached).toBe(1);
		expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("input.txt:2: match") }]);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("removes the abort listener when tool discovery fails", async () => {
		vi.mocked(ensureTool).mockRejectedValue(new Error("discovery failed"));
		await expect(
			createGrepTool(directory).execute("discovery-error", { pattern: "match" }, controller.signal),
		).rejects.toThrow("discovery failed");
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});
});
