import dgram from "node:dgram";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { frameMessage, hasHeader, RequestMessageType, ResponseMessageType } from "../codec.js";
import { P2PSession } from "../p2p-session.js";
import { LiveStream } from "../live-stream.js";

/** A real loopback peer; no production endpoint or mocked socket receive path. */
async function peer(host = "127.0.0.1") {
  const socket = dgram.createSocket("udp4");
  socket.bind(0, host);
  await once(socket, "listening");
  return socket;
}

/** Connect through an actual CAM_ID datagram, then retain the observed client source port. */
async function connectedPeer() {
  const remote = await peer();
  const packets: Buffer[] = [];
  remote.on("message", (packet, source) => {
    packets.push(packet);
    if (hasHeader(packet, RequestMessageType.DATA)) {
      remote.send(
        frameMessage(
          ResponseMessageType.ACK,
          Buffer.concat([packet.subarray(4, 6), Buffer.from([0, 1]), packet.subarray(6, 8)]),
        ),
        source.port,
        source.address,
      );
    }
  });
  const session = new P2PSession({ stationSn: "T8000P0000000000", p2pDid: "XXXXXXX-000000-XXXXX", noBroadcast: true });
  session.on("error", () => undefined);
  await session.connect();
  const clientPort = (session as unknown as { socket: dgram.Socket }).socket.address().port;
  const connected = once(session, "connect");
  remote.send(frameMessage(ResponseMessageType.CAM_ID), clientPort, "127.0.0.1");
  await connected;
  return { remote, session, clientPort, packets };
}

describe("peer-ended P2P sessions over UDP", () => {
  it("closes promptly and stops a live stream instead of sending keepalives on an ended connection", async () => {
    const { remote, session, clientPort, packets } = await connectedPeer();
    const stream = new LiveStream(session, { channel: 0, keepAliveMs: 20 });
    const stopped = vi.fn();
    stream.on("stop", stopped);
    try {
      stream.start();
      await vi.waitFor(() =>
        expect(packets.some((p) => hasHeader(p, RequestMessageType.DATA) && p.readUInt16LE(12) === 1139)).toBe(true),
      );
      const closed = vi.fn();
      session.on("close", closed);
      remote.send(frameMessage(ResponseMessageType.END), clientPort, "127.0.0.1");
      await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce(), { timeout: 500, interval: 5 });
      expect(session.isConnected).toBe(false);
      expect(stopped).toHaveBeenCalledOnce();
      await delay(20);
      const count = packets.length;
      await delay(80);
      expect(packets).toHaveLength(count);
      const rebound = dgram.createSocket("udp4");
      try {
        rebound.bind(clientPort, "127.0.0.1");
        await once(rebound, "listening");
      } finally {
        rebound.close();
      }
    } finally {
      stream.stop();
      await session.close();
      remote.close();
    }
  });

  it("ignores an END from a different port or host, then accepts the current peer's END", async () => {
    const { remote, session, clientPort, packets } = await connectedPeer();
    const foreignPort = await peer();
    const receiver = session as unknown as {
      onMessage: (packet: Buffer, source: { address: string; port: number }) => void;
    };
    const stream = new LiveStream(session, { channel: 0, keepAliveMs: 20 });
    const stopped = vi.fn();
    stream.on("stop", stopped);
    try {
      stream.start();
      foreignPort.send(frameMessage(ResponseMessageType.END), clientPort, "127.0.0.1");
      receiver.onMessage(frameMessage(ResponseMessageType.END), { address: "192.0.2.1", port: remote.address().port });
      for (const malformed of ["f1f0", "f1f000", "f1f00001", "f1f0000001"]) {
        remote.send(Buffer.from(malformed, "hex"), clientPort, "127.0.0.1");
      }
      await delay(80);
      expect(session.isConnected).toBe(true);
      expect(stopped).not.toHaveBeenCalled();
      expect(packets.some((p) => hasHeader(p, RequestMessageType.DATA) && p.readUInt16LE(12) === 1139)).toBe(true);
      remote.send(frameMessage(ResponseMessageType.END, Buffer.from([1])), clientPort, "127.0.0.1");
      await vi.waitFor(() => expect(stopped).toHaveBeenCalledOnce(), { timeout: 500, interval: 5 });
    } finally {
      stream.stop();
      await session.close();
      remote.close();
      foreignPort.close();
    }
  });

  it("ignores a delayed END from the previous connection after reconnecting to a new peer", async () => {
    const { remote: oldPeer, session } = await connectedPeer();
    const currentPeer = await peer();
    try {
      await session.close();
      await session.connect();
      const port = (session as unknown as { socket: dgram.Socket }).socket.address().port;
      const connected = once(session, "connect");
      currentPeer.send(frameMessage(ResponseMessageType.CAM_ID), port, "127.0.0.1");
      await connected;
      oldPeer.send(frameMessage(ResponseMessageType.END), port, "127.0.0.1");
      await delay(80);
      expect(session.isConnected).toBe(true);
      const closed = vi.fn();
      session.on("close", closed);
      currentPeer.send(frameMessage(ResponseMessageType.END), port, "127.0.0.1");
      await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce(), { timeout: 500, interval: 5 });
    } finally {
      await session.close();
      oldPeer.close();
      currentPeer.close();
    }
  });
});
