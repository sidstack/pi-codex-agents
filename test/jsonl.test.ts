import { describe, expect, it } from "vitest";
import { createJsonlReader, encodeJsonl, isParseError } from "../src/core/jsonl.ts";

function collect(): { records: unknown[]; write: (chunk: Buffer | string) => void; end: () => void } {
	const records: unknown[] = [];
	const reader = createJsonlReader((record) => records.push(record));
	return { records, write: (chunk) => reader.write(chunk), end: () => reader.end() };
}

describe("JSONL framing", () => {
	it("splits records only on LF and tolerates arbitrary chunk boundaries", () => {
		const { records, write, end } = collect();
		const record = { id: "1", type: "get_state" };
		const body = JSON.stringify(record);
		write(body.slice(0, 4));
		write(body.slice(4, 11));
		write(body.slice(11));
		expect(records.length).toBe(0);
		write("\n");
		expect(records).toEqual([record]);
		end();
	});

	it("handles several records in one chunk and CRLF terminators", () => {
		const { records, write } = collect();
		write(`${JSON.stringify({ a: 1 })}\n${JSON.stringify({ b: 2 })}\r\n`);
		expect(records).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("does not treat U+2028/U+2029 as record boundaries", () => {
		const { records, write } = collect();
		// Real LINE SEPARATOR and PARAGRAPH SEPARATOR, not lookalikes: JSON
		// permits them raw inside strings, so they must not split a record.
		const text = `line one \u2028 line two \u2029 done`;
		const encoded = encodeJsonl({ type: "message_update", delta: text });
		expect(encoded).toContain("\u2028");
		expect(encoded).toContain("\u2029");
		write(encoded);
		expect(records.length).toBe(1);
		expect((records[0] as { delta: string }).delta).toBe(text);
	});

	it("decodes multibyte text split at every byte boundary", () => {
		// 4-byte emoji, 3-byte CJK, 2-byte Latin-1, and the JSON separators.
		const samples = ["A😀B", "日本語", "éclair", "a\u2028b\u2029c", "🧪 mixed 文本 é"];
		for (const text of samples) {
			const bytes = Buffer.from(encodeJsonl({ text }), "utf8");
			for (let split = 1; split < bytes.length; split++) {
				const { records, write, end } = collect();
				write(bytes.subarray(0, split));
				write(bytes.subarray(split));
				end();
				expect(records.length, `split ${split} of ${text}`).toBe(1);
				expect(isParseError(records[0] as object), `split ${split}`).toBe(false);
				expect((records[0] as { text: string }).text, `split ${split} of ${text}`).toBe(text);
			}
		}
	});

	it("carries an incomplete sequence across many one-byte chunks", () => {
		const bytes = Buffer.from(`${encodeJsonl({ text: "😀日本語éclair" })}\n`, "utf8");
		const { records, write, end } = collect();
		for (const byte of bytes) write(Buffer.from([byte]));
		end();
		expect(records).toEqual([{ text: "😀日本語éclair" }]);
	});

	it("decodes a truncated trailing sequence as one replacement character, not per byte", () => {
		const { records, write, end } = collect();
		write(Buffer.from('{"text":"ab', "utf8"));
		write(Buffer.from([0xf0, 0x9f])); // first half of a 4-byte emoji
		end();
		expect(records.length).toBe(1);
		expect(isParseError(records[0] as object)).toBe(true);
	});

	it("reports malformed records instead of throwing", () => {
		const { records, write } = collect();
		write("{not json}\n");
		expect(records.length).toBe(1);
		expect(isParseError(records[0] as object)).toBe(true);
	});

	it("flushes a trailing record without a final LF on end()", () => {
		const { records, write, end } = collect();
		write(JSON.stringify({ tail: true }));
		expect(records.length).toBe(0);
		end();
		expect(records).toEqual([{ tail: true }]);
	});
});

describe("bounded records", () => {
  it("rejects oversized complete records and continues on LF", () => {
    const records: unknown[] = [];
    const reader = createJsonlReader((value) => records.push(value), 16);
    reader.write(JSON.stringify("a".repeat(20)) + '\n{"ok":true}\n');
    expect(records).toEqual([{ __parseError: "JSONL record exceeds byte limit" }, { ok: true }]);
  });

  it("drops an oversized partial record until LF and counts UTF-8 bytes", () => {
    const records: unknown[] = [];
    const reader = createJsonlReader((value) => records.push(value), 16);
    reader.write('"' + "😀".repeat(4));
    expect(reader.pending()).toBe(0);
    reader.write('remaining"\n{"ok":true}\n');
    expect(records).toEqual([{ __parseError: "JSONL record exceeds byte limit" }, { ok: true }]);
  });
});
