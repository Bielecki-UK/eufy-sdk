import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveStreamHandle, LiveVideoFrame, ReceivedVideoFrame } from "../../../core/contracts.js";
import { openReadableFromConsumer } from "../readable-egress.js";
import { SharedLiveSource, type TimedMediaFrame } from "../shared-live-source.js";

class ReceiptStream extends EventEmitter implements LiveStreamHandle {
  start(): this {
    return this;
  }
  stop(): void {}
  requestKeyframe(): void {}
  video(frame: LiveVideoFrame): void {
    this.emit("video", frame);
  }
}

const sources: SharedLiveSource[] = [];
const readers: Readable[] = [];

/** Synthetic clocks with independent wall corrections and process-monotonic progress. */
function clocks() {
  let wall = 1_000;
  let mono = 1_000_000n;
  vi.spyOn(Date, "now").mockImplementation(() => wall);
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => mono * 1_000n);
  return {
    set(nextMono: bigint, nextWall = wall) {
      mono = nextMono;
      wall = nextWall;
    },
  };
}

/** Actual shared-source and readable fan-out over synthetic frame transport. */
function harness(maxQueue = 8) {
  const stream = new ReceiptStream();
  const source = new SharedLiveSource({ makeStream: () => stream, lingerMs: 8_000, maxQueue });
  sources.push(source);
  return { source, stream };
}

/** One synthetic Annex-B slice with a declared configuration and original source word. */
function frame(keyframe = true, codec: "h264" | "h265" = "h264", width = 640): LiveVideoFrame {
  return {
    codec,
    width,
    height: 360,
    keyframe,
    sourceTimestamp: 77,
    data: Buffer.from([0, 0, 0, 1, keyframe ? 0x65 : 0x41]),
  };
}

/** Track caller-owned readers for cleanup even if an assertion fails. */
function track(reader: Readable): Readable {
  readers.push(reader);
  return reader;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => {
  for (const reader of readers.splice(0)) reader.destroy();
  for (const source of sources.splice(0)) source.dispose();
  vi.restoreAllMocks();
});

describe("original media receipt through video Readable", () => {
  it("preserves the same aged prime receipt rather than minting delivery time or identity", async () => {
    const clock = clocks();
    const { source, stream } = harness();
    const original = frame();
    const first = source.attach();
    let retained: Extract<TimedMediaFrame, { kind: "video" }> | undefined;
    first.onMedia((item) => {
      if (item.kind === "video") retained = item;
    });
    stream.video(original);
    first.detach();
    clock.set(6_000_000n, 6_000);
    const reused = source.attach();
    const received: ReceivedVideoFrame[] = [];
    const reader = track(openReadableFromConsumer(reused, { objectMode: true, receiptMetadata: true }));
    reader.on("data", (value) => received.push(value));
    await flush();
    expect(received).toHaveLength(1);
    expect(received[0].frame).toBe(original);
    expect(received[0].receipt).toBe(retained!.receipt);
    expect(received[0].receipt.monotonicUs).toBe(1_000_000n);
    expect(6_000_000n - received[0].receipt.monotonicUs).toBe(5_000_000n);
    expect(received[0].receipt.sequence).toBe(1n);
    expect(Object.isFrozen(received[0].receipt)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(retained!, "receipt")?.writable).toBe(false);
    expect(Object.keys(retained!)).not.toContain("receipt");
    expect(() => JSON.stringify(retained!)).not.toThrow();
    expect(Object.isFrozen(received[0])).toBe(true);
    expect(Object.hasOwn(original, "receipt")).toBe(false);
  });

  it("preserves original arrival order and codec/configuration under Readable backpressure", async () => {
    const clock = clocks();
    const { source, stream } = harness();
    const consumer = source.attach();
    const configs: unknown[] = [];
    consumer.on("video-config", (config) => configs.push(config));
    const reader = track(
      openReadableFromConsumer(consumer, { objectMode: true, receiptMetadata: true, highWaterMark: 1 }),
    );
    const values = [frame(), frame(false), frame(true, "h265", 1280)];
    stream.video(values[0]);
    clock.set(2_000_000n, 2_000);
    stream.video(values[1]);
    clock.set(3_000_000n, 3_000);
    stream.video(values[2]);
    expect(reader.readableLength).toBe(1);
    clock.set(9_000_000n, 9_000);
    const received: ReceivedVideoFrame[] = [];
    reader.on("data", (value) => received.push(value));
    await flush();
    expect(received.map((value) => value.frame)).toEqual(values);
    values.forEach((value, i) => expect(received[i].frame).toBe(value));
    expect(received.map((value) => value.receipt.monotonicUs)).toEqual([1_000_000n, 2_000_000n, 3_000_000n]);
    expect(received.map((value) => value.receipt.sequence)).toEqual([1n, 2n, 3n]);
    expect(new Set(received.map((value) => value.receipt.sourceId)).size).toBe(1);
    expect(configs).toEqual([
      { codec: "h264", width: 640, height: 360 },
      { codec: "h265", width: 1280, height: 360 },
    ]);
  });

  it("keeps overflow drop-to-keyframe semantics and the surviving original receipts", async () => {
    const clock = clocks();
    const { source, stream } = harness(2);
    const consumer = source.attach();
    const reader = track(
      openReadableFromConsumer(consumer, { objectMode: true, receiptMetadata: true, highWaterMark: 1 }),
    );
    const first = frame();
    stream.video(first);
    for (let i = 2; i <= 4; i++) {
      clock.set(BigInt(i) * 1_000_000n);
      stream.video(frame(false));
    }
    const nextKey = frame();
    clock.set(5_000_000n);
    stream.video(nextKey);
    clock.set(9_000_000n);
    const received: ReceivedVideoFrame[] = [];
    reader.on("data", (value) => received.push(value));
    await flush();
    expect(received.map((value) => value.frame)).toEqual([first, nextKey]);
    expect(received.map((value) => value.receipt.sequence)).toEqual([1n, 5n]);
    expect(received.map((value) => value.receipt.monotonicUs)).toEqual([1_000_000n, 5_000_000n]);
  });

  it("uses process-monotonic receipt independently of a backwards wall-clock jump", async () => {
    const clock = clocks();
    const { source, stream } = harness();
    const reader = track(openReadableFromConsumer(source.attach(), { objectMode: true, receiptMetadata: true }));
    const received: ReceivedVideoFrame[] = [];
    reader.on("data", (value) => received.push(value));
    stream.video(frame());
    clock.set(2_000_000n, -9_000_000);
    stream.video(frame(false));
    await flush();
    expect(received.map((value) => value.receipt.monotonicUs)).toEqual([1_000_000n, 2_000_000n]);
    expect(received.map((value) => value.receipt.sequence)).toEqual([1n, 2n]);
  });
});
