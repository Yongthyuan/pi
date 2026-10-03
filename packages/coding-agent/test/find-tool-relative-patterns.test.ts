import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFindTool } from "../src/core/tools/find.ts";

// Regression coverage for https://github.com/earendil-works/pi/issues/10418
describe("find relative path patterns", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-find-relative-"));
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	function writeFiles(root: string, files: string[]) {
		for (const file of files) {
			const filePath = join(root, file);
			mkdirSync(dirname(filePath), { recursive: true });
			writeFileSync(filePath, "");
		}
	}

	async function runFind(cwd: string, pattern: string, searchDir?: string): Promise<string[]> {
		const result = await createFindTool(cwd).execute("find-relative", { pattern, path: searchDir });
		const output = result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		return output === "No files found matching pattern" ? [] : output.split("\n").sort();
	}

	it.each(["./src/**/*.ts", "././src/**/*.ts"])("accepts leading dot segments in %s", async (pattern) => {
		writeFiles(tempRoot, ["src/example.ts", "src/nested/other.ts"]);
		expect(await runFind(tempRoot, pattern)).toEqual(["src/example.ts", "src/nested/other.ts"]);
	});

	it.each(["src/**/*.ts", "**/src/**/*.ts"])("does not match the search root's own name with %s", async (pattern) => {
		const searchRoot = join(tempRoot, "src");
		writeFiles(searchRoot, ["tests/example.ts"]);
		expect(await runFind(searchRoot, pattern)).toEqual([]);
	});

	it("anchors a directory-prefixed pattern to the selected search directory", async () => {
		writeFiles(tempRoot, ["project/src/example.ts", "project/packages/nested/src/other.ts"]);
		expect(await runFind(tempRoot, "src/**/*.ts", "project")).toEqual(["src/example.ts"]);
	});

	it("allows explicit recursive path patterns inside the search directory", async () => {
		writeFiles(tempRoot, ["src/example.ts", "packages/nested/src/other.ts"]);
		expect(await runFind(tempRoot, "**/src/**/*.ts")).toEqual(["packages/nested/src/other.ts", "src/example.ts"]);
	});

	it("keeps basename searches recursive", async () => {
		writeFiles(tempRoot, ["example.ts", "src/other.ts"]);
		expect(await runFind(tempRoot, "*.ts")).toEqual(["example.ts", "src/other.ts"]);
	});

	it("treats glob characters in the search directory literally", async () => {
		const searchRoot = join(tempRoot, "project [test] {a,b}");
		writeFiles(searchRoot, ["src/example.ts"]);
		expect(await runFind(searchRoot, "src/**/*.ts")).toEqual(["src/example.ts"]);
	});

	it("keeps smart case dependent on the pattern, not the search directory", async () => {
		const searchRoot = join(tempRoot, "Project");
		writeFiles(searchRoot, ["src/upper.TS", "src/lower.ts"]);
		expect(await runFind(searchRoot, "src/**/*.ts")).toEqual(["src/lower.ts", "src/upper.TS"]);
		expect(await runFind(searchRoot, "src/**/*.TS")).toEqual(["src/upper.TS"]);
	});

	it("preserves absolute patterns", async () => {
		writeFiles(tempRoot, ["src/example.ts"]);
		const pattern = `${tempRoot.split("\\").join("/")}/src/**/*.ts`;
		expect(await runFind(tempRoot, pattern)).toEqual(["src/example.ts"]);
	});
});
