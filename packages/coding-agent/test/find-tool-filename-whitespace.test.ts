import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFindTool } from "../src/core/tools/find.ts";

// Regression coverage for https://github.com/earendil-works/pi/issues/10559
// Windows normalizes trailing spaces and does not allow tabs in filenames.
describe.skipIf(process.platform === "win32")("find preserves filename whitespace", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-find-whitespace-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	async function runFind(pattern: string): Promise<string> {
		const result = await createFindTool(root).execute("find-whitespace", { pattern });
		const content = result.content[0];
		expect(content.type).toBe("text");
		if (content.type !== "text") throw new Error("Expected find text output");
		return content.text;
	}

	it.each([" ", "\t", "\u00a0"])("keeps trailing whitespace %j instead of returning another file", async (suffix) => {
		const name = `report.txt${suffix}`;
		writeFileSync(join(root, "report.txt"), "different file");
		writeFileSync(join(root, name), "intended file");

		const output = await runFind(name);
		expect(output).toBe(name);
		expect(readFileSync(join(root, output), "utf8")).toBe("intended file");
	});

	it("does not merge distinct filenames in a multi-result search", async () => {
		writeFileSync(join(root, "report.txt"), "first");
		writeFileSync(join(root, "report.txt "), "second");

		const output = await runFind("report.txt*");
		expect(output.split("\n").sort()).toEqual(["report.txt", "report.txt "]);
	});

	it("preserves a filename consisting only of spaces", async () => {
		writeFileSync(join(root, "   "), "intended file");

		const output = await runFind("   ");
		expect(output).toBe("   ");
		expect(readFileSync(join(root, output), "utf8")).toBe("intended file");
	});
});
