/**
 * Strict JSONL record framing.
 *
 * Records are separated by LF only. An optional preceding CR is stripped.
 * U+2028/U+2029 and other Unicode separators are valid inside JSON strings and
 * must NOT be treated as record boundaries (Node's `readline` does, so it is
 * unusable here). Chunk boundaries are arbitrary: a record can arrive split
 * across many chunks or with several records in one chunk.
 */
import { StringDecoder } from "node:string_decoder";
export const MAX_JSONL_RECORD_BYTES = 4 * 1024 * 1024;
export function isParseError(record) {
    return typeof record === "object" && record !== null && "__parseError" in record;
}
export function createJsonlReader(onRecord, maxRecordBytes = MAX_JSONL_RECORD_BYTES) {
    let buffer = "";
    let dropping = false;
    /**
     * Chunk boundaries are arbitrary, including the middle of a multibyte code
     * point. Decoding each Buffer independently turns a split character into
     * replacement characters, so decoding streams: an incomplete sequence is
     * held by the decoder and completed by the next chunk.
     */
    const decoder = new StringDecoder("utf8");
    const consumeLine = (raw) => {
        if (dropping) {
            dropping = false;
            return;
        }
        if (Buffer.byteLength(raw) > maxRecordBytes) {
            onRecord({ __parseError: "JSONL record exceeds byte limit" });
            return;
        }
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (!line)
            return;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            onRecord({ __parseError: line.slice(0, 200) });
            return;
        }
        onRecord(parsed);
    };
    return {
        write(chunk) {
            buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
            let index;
            while ((index = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 1);
                consumeLine(line);
            }
            if (Buffer.byteLength(buffer) > maxRecordBytes) {
                if (!dropping)
                    onRecord({ __parseError: "JSONL record exceeds byte limit" });
                dropping = true;
                buffer = "";
            }
        },
        end() {
            buffer += decoder.end();
            if (buffer) {
                const line = buffer;
                buffer = "";
                consumeLine(line);
            }
            dropping = false;
        },
        pending() {
            return buffer.length;
        },
    };
}
export function encodeJsonl(value) {
    return `${JSON.stringify(value)}\n`;
}
//# sourceMappingURL=jsonl.js.map