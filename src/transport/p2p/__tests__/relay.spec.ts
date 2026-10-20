import dgram from "node:dgram";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";
import { LIVE_TRACE_MESSAGE } from "../live-trace.js";
import {
  RequestMessageType,
  ResponseMessageType,
  frameMessage,
  hasHeader,
  p2pDidToBuffer,
  parseRelayList,
  parseRelayPortAck,
  parseRelayTo,
} from "../codec.js";

/**
 * A station a direct path cannot reach is connected through a PPCS relay, in the vendor client's order:
 * ListReq_DSK → LIST_REQ_ACK → RLY_HELLO → RLY_HELLO_ACK → RLY_PORT → RLY_PORT_ACK → RLY_REQ → RLY_RDY.
 */
const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";

async function peer(): Promise<dgram.Socket> {
  const socket = dgram.createSocket("udp4");
  socket.bind(0, "127.0.0.1");
  await once(socket, "listening");
  return socket;
}

/** A 16-byte address record for 127.0.0.1 on `port`. */
function loopbackRecord(port: number): Buffer {
  const record = Buffer.alloc(16);
  record.writeUInt16BE(0x0002, 0);
  record.writeUInt16LE(port, 2);
  record.set([1, 0, 0, 127], 4);
  return record;
}

describe("PPCS relay fallback", () => {
  it("connects through the relay a cloud lookup server lists, with the relay as the peer", async () => {
    const cloud = await peer();
    const relay = await peer();
    const relayed = await peer();
    const MARK = 0x01020304;
    let requested: Buffer | undefined;
    let pingPort: number | undefined;
    const connected = vi.fn();
    const debug = vi.fn();
    const session = new P2PSession({
      stationSn: STATION_SN,
      p2pDid: P2P_DID,
      dskKey: "0".repeat(20),
      cloudAddresses: [{ host: "127.0.0.1", port: cloud.address().port }],
      noBroadcast: true,
      logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    session.on("error", () => undefined);
    session.on("connect", connected);
    cloud.on("message", (msg, remote) => {
      if (hasHeader(msg, RequestMessageType.LOOKUP_WITH_KEY2)) {
        const list = Buffer.concat([Buffer.from([1, 0, 0, 0]), loopbackRecord(relay.address().port)]);
        cloud.send(frameMessage(ResponseMessageType.LIST_REQ_ACK, list), remote.port, remote.address);
      } else if (hasHeader(msg, RequestMessageType.RLY_REQ) && !requested) {
        requested = msg;
        cloud.send(frameMessage(ResponseMessageType.RLY_REQ_ACK, Buffer.alloc(4)), remote.port, remote.address);
        relayed.send(frameMessage(ResponseMessageType.RLY_RDY, p2pDidToBuffer(P2P_DID)), remote.port, remote.address);
      }
    });
    relay.on("message", (msg, remote) => {
      if (hasHeader(msg, RequestMessageType.RLY_HELLO))
        relay.send(frameMessage(ResponseMessageType.RLY_HELLO_ACK), remote.port, remote.address);
      if (hasHeader(msg, RequestMessageType.RLY_PORT)) {
        const ack = Buffer.alloc(8);
        ack.writeUInt32BE(MARK, 0);
        ack.writeUInt16BE(relayed.address().port, 4);
        relay.send(frameMessage(ResponseMessageType.RLY_PORT_ACK, ack), remote.port, remote.address);
      }
    });
    relayed.on("message", (msg, remote) => {
      if (hasHeader(msg, RequestMessageType.PING)) pingPort = remote.port;
    });
    try {
      await session.connect();
      await vi.waitFor(() => expect(connected).toHaveBeenCalledOnce(), { timeout: 9_000 });
      expect(requested!.subarray(4, 24)).toEqual(p2pDidToBuffer(P2P_DID));
      expect(requested!.subarray(24, 40)).toEqual(loopbackRecord(relayed.address().port));
      expect(requested!.readUInt32BE(40)).toBe(MARK);
      await vi.waitFor(() => expect(pingPort).toBeDefined());
      const paths = debug.mock.calls
        .filter(([message]) => message === LIVE_TRACE_MESSAGE)
        .map(([, trace]) => trace)
        .filter((trace) => trace.phase === "session-path");
      expect(paths).toEqual([expect.objectContaining({ via: "relay" })]);
    } finally {
      await session.close();
      cloud.close();
      relay.close();
      relayed.close();
    }
  }, 12_000);

  it("registers with a RLY_TO endpoint instead of hole-punching it, and connects only on its own device's RLY_RDY", () => {
    const send = vi.fn();
    const connected = vi.fn();
    const session = new P2PSession({ stationSn: STATION_SN, p2pDid: P2P_DID });
    session.on("connect", connected);
    const internals = session as unknown as {
      socket: unknown;
      onMessage(msg: Buffer, rinfo: object, socket?: unknown): void;
    };
    const socket = { send, removeAllListeners: vi.fn(), on: vi.fn(), setRecvBufferSize: vi.fn() };
    internals.socket = socket;
    const handle = Buffer.alloc(4);
    handle.writeUInt32BE(0xcafe0001, 0);
    internals.onMessage(frameMessage(ResponseMessageType.RLY_TO, Buffer.concat([loopbackRecord(40000), handle])), {
      address: "192.0.2.9",
      port: 32100,
    });
    const sent = send.mock.calls.map(([packet, port, host]) => ({ packet: packet as Buffer, port, host }));
    expect(sent).toHaveLength(4);
    for (const { packet, port, host } of sent) {
      expect([host, port]).toEqual(["127.0.0.1", 40000]);
      expect(hasHeader(packet, RequestMessageType.RLY_PKT)).toBe(true);
      expect(packet.subarray(4)).toEqual(Buffer.concat([handle, p2pDidToBuffer(P2P_DID), Buffer.alloc(4)]));
    }
    send.mockClear();
    internals.onMessage(frameMessage(ResponseMessageType.RLY_RDY, p2pDidToBuffer("XXXXXXX-000001-XXXXX")), {
      address: "127.0.0.1",
      port: 40000,
    });
    expect(connected).not.toHaveBeenCalled();
    internals.onMessage(frameMessage(ResponseMessageType.RLY_RDY, p2pDidToBuffer(P2P_DID)), {
      address: "127.0.0.1",
      port: 40000,
    });
    expect(connected).toHaveBeenCalledOnce();
    void session.close().catch(() => undefined);
  });
});

describe("a connect that times out", () => {
  it("names the relay step it was waiting on", async () => {
    const cloud = await peer();
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    const errors: Error[] = [];
    const session = new P2PSession({
      stationSn: STATION_SN,
      p2pDid: P2P_DID,
      dskKey: "0".repeat(20),
      cloudAddresses: [{ host: "127.0.0.1", port: cloud.address().port }],
      noBroadcast: true,
    });
    session.on("error", (error: Error) => errors.push(error));
    try {
      await session.connect();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(errors.map((e) => e.message)).toEqual([`P2P connect timeout for ${STATION_SN} (relay: list)`]);
    } finally {
      vi.useRealTimers();
      await session.close();
      cloud.close();
    }
  });

  it("says the relay was not available without a cloud lookup", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    const errors: Error[] = [];
    const session = new P2PSession({ stationSn: STATION_SN, p2pDid: P2P_DID, noBroadcast: true });
    session.on("error", (error: Error) => errors.push(error));
    try {
      await session.connect();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(errors.map((e) => e.message)).toEqual([`P2P connect timeout for ${STATION_SN} (relay: no cloud lookup)`]);
    } finally {
      vi.useRealTimers();
      await session.close();
    }
  });
});

describe("relay message parsing", () => {
  it("reads a relay list once per relay, without the unspecified address or records past the end", () => {
    const zero = Buffer.alloc(16);
    const msg = frameMessage(
      ResponseMessageType.LIST_REQ_ACK,
      Buffer.concat([Buffer.from([4, 0, 0, 0]), loopbackRecord(1), loopbackRecord(1), zero, loopbackRecord(2)]),
    );
    expect(parseRelayList(msg)).toEqual([
      { host: "127.0.0.1", port: 1 },
      { host: "127.0.0.1", port: 2 },
    ]);
    expect(parseRelayList(msg.subarray(0, 8 + 16))).toEqual([{ host: "127.0.0.1", port: 1 }]);
  });

  it("reads a port acknowledgement's mark and port, and a RLY_TO's endpoint and handle", () => {
    const ack = Buffer.from([0xf1, 0x73, 0, 8, 0, 0, 0, 7, 0x9c, 0x40, 0, 0]);
    expect(parseRelayPortAck(ack)).toEqual({ mark: 7, port: 40000 });
    expect(parseRelayPortAck(ack.subarray(0, 9))).toBeUndefined();
    const to = frameMessage(ResponseMessageType.RLY_TO, Buffer.concat([loopbackRecord(5), Buffer.from([0, 0, 0, 9])]));
    expect(parseRelayTo(to)).toEqual({ address: { host: "127.0.0.1", port: 5 }, handle: 9 });
  });
});
