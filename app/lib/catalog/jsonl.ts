/**
 * Task 6A — a bounded-memory, line-oriented parser for Shopify bulk-operation results.
 *
 * A bulk query returns a JSONL file (one JSON object per line, connections flattened via
 * `__parentId`). For 6,500 products + variants that file is multi-MB; it is NEVER read
 * into memory whole. This parser consumes an async iterable of `Uint8Array` chunks
 * (from `fetch(url).body` or a local test stream), emits one parsed object at a time,
 * and only ever buffers the current partial line (capped at `JSONL_MAX_LINE_BYTES`).
 *
 * `startByteOffset` lets an interrupted parse resume: the caller records the byte
 * position after each fully-processed line in `CatalogSyncJob.resumeByteOffset`; on
 * resume it re-fetches the result with a `Range` header (or slices a local buffer) from
 * that offset and passes the offset so emitted objects carry an absolute `byteEnd`.
 */

import { JSONL_MAX_LINE_BYTES } from "./constants.ts";

export interface JsonlRecord {
  /** the parsed line */
  value: Record<string, unknown>;
  /** absolute byte offset of this line's FIRST byte — the resume checkpoint to use when
   * a bounded ingest stops *before* consuming this record (Task 6A.1) */
  byteStart: number;
  /** absolute byte offset of the first byte AFTER this line's terminating "\n" —
   * the safe resume checkpoint once this record is fully persisted */
  byteEnd: number;
  /** 1-based line number within the whole file */
  lineNumber: number;
}

export class JsonlParseError extends Error {
  readonly lineNumber: number;
  constructor(message: string, lineNumber: number) {
    super(message);
    this.name = "JsonlParseError";
    this.lineNumber = lineNumber;
  }
}

export async function* parseJsonl(
  chunks: AsyncIterable<Uint8Array>,
  opts: { startByteOffset?: number; startLineNumber?: number } = {},
): AsyncGenerator<JsonlRecord, void, unknown> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let bytePos = opts.startByteOffset ?? 0;
  let lineNumber = opts.startLineNumber ?? 0;

  for await (const chunk of chunks) {
    // stream: true so a multi-byte char split across chunks is handled correctly
    buffer += decoder.decode(chunk, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const byteStart = bytePos;
      // byte length of the line + the "\n"
      bytePos += byteLen(line) + 1;
      lineNumber += 1;
      if (line.trim().length === 0) continue;
      yield { value: parseLine(line, lineNumber), byteStart, byteEnd: bytePos, lineNumber };
    }

    if (byteLen(buffer) > JSONL_MAX_LINE_BYTES) {
      throw new JsonlParseError(
        `single line exceeded ${JSONL_MAX_LINE_BYTES} bytes without a newline — result stream is malformed`,
        lineNumber + 1,
      );
    }
  }

  buffer += decoder.decode(); // flush
  const trailing = buffer.trim();
  if (trailing.length > 0) {
    // A well-formed bulk result ends with a newline; tolerate a final line without one.
    const byteStart = bytePos;
    bytePos += byteLen(buffer);
    lineNumber += 1;
    yield { value: parseLine(trailing, lineNumber), byteStart, byteEnd: bytePos, lineNumber };
  }
}

function parseLine(line: string, lineNumber: number): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new JsonlParseError(`line ${lineNumber} is not valid JSON`, lineNumber);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new JsonlParseError(`line ${lineNumber} is not a JSON object`, lineNumber);
  }
  return parsed as Record<string, unknown>;
}

const enc = new TextEncoder();
function byteLen(s: string): number {
  return enc.encode(s).length;
}

/** Adapts a single string / Uint8Array into the async-iterable shape `parseJsonl`
 * expects — for tests and for a fully-buffered small result. */
export async function* fromString(text: string, chunkSize = 4096): AsyncGenerator<Uint8Array> {
  const bytes = enc.encode(text);
  for (let i = 0; i < bytes.length; i += chunkSize) {
    yield bytes.subarray(i, i + chunkSize);
  }
}
