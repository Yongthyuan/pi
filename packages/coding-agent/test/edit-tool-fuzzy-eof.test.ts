import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch } from "diff";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";
import { computeEditsDiff } from "../src/core/tools/edit-diff.ts";

// Regression for https://github.com/earendil-works/pi/issues/10340
describe("fuzzy edits with an unterminated whitespace-only final line", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-edit-fuzzy-eof-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it.each(["   ", "\t", "\u00a0"])("preserves an untouched final line containing %j", async (suffix) => {
		const path = join(root, "example.ts");
		const original = `const x = 1;  \nunchanged\n${suffix}`;
		const expected = `const x = 2;\nunchanged\n${suffix}`;
		writeFileSync(path, original);

		const result = await createEditTool(root).execute("edit-eof", {
			path: "example.ts",
			edits: [{ oldText: "const x = 1;\n", newText: "const x = 2;\n" }],
		});

		expect(readFileSync(path, "utf8")).toBe(expected);
		expect(applyPatch(original, result.details?.patch ?? "")).toBe(expected);
		expect(result.details?.firstChangedLine).toBe(1);
	});

	it("preserves the final line when a batch mixes exact and fuzzy replacements", async () => {
		const path = join(root, "example.ts");
		const original = "const x = 1;  \nkeep this\nconst y = 3;\n\t ";
		const expected = "const x = 2;\nkeep this\nconst y = 4;\n\t ";
		writeFileSync(path, original);

		const result = await createEditTool(root).execute("edit-batch-eof", {
			path: "example.ts",
			edits: [
				{ oldText: "const x = 1;\n", newText: "const x = 2;\n" },
				{ oldText: "const y = 3;", newText: "const y = 4;" },
			],
		});

		expect(readFileSync(path, "utf8")).toBe(expected);
		expect(applyPatch(original, result.details?.patch ?? "")).toBe(expected);
	});

	it("previews the same edit without changing the file", async () => {
		const path = join(root, "example.ts");
		const original = "const x = 1;  \nunchanged\n   ";
		writeFileSync(path, original);

		const preview = await computeEditsDiff(
			"example.ts",
			[{ oldText: "const x = 1;\n", newText: "const x = 2;\n" }],
			root,
		);

		expect(preview).not.toHaveProperty("error");
		expect(preview).toHaveProperty("firstChangedLine", 1);
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	it("preserves CRLF endings and the UTF-8 BOM", async () => {
		const path = join(root, "example.ts");
		writeFileSync(path, "\uFEFFconst x = 1;  \r\nunchanged\r\n   ");

		await createEditTool(root).execute("edit-crlf-eof", {
			path: "example.ts",
			edits: [{ oldText: "const x = 1;\n", newText: "const x = 2;\n" }],
		});

		expect(readFileSync(path, "utf8")).toBe("\uFEFFconst x = 2;\r\nunchanged\r\n   ");
	});
});
