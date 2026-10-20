import dgram from "node:dgram";
import { afterEach, describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";
import { RequestMessageType } from "../codec.js";

const cleanup: dgram.Socket[] = [];
async function bound() {
  const socket = dgram.createSocket("udp4");
  cleanup.push(socket);
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return socket;
}
function sessionWith(socket: dgram.Socket, port?: number) {
  const session = new P2PSession({ stationSn: "T8000P0000000000", p2pDid: "XXXXXXX-000000-XXXXX" });
  Object.assign(session, {
    socket,
    connected: true,
    ...(port === undefined ? {} : { connectAddress: { host: "127.0.0.1", port } }),
    level2Key: Buffer.alloc(32, 1),
  });
  return session;
}
afterEach(() => {
  for (const socket of cleanup.splice(0)) {
    try {
      socket.close();
    } catch {
      /* Socket already closed by the session. */
    }
  }
});

describe("P2P session close", () => {
  it("delivers queued attached STOP and END through the same real UDP socket", async () => {
    const counts: number[] = [];
    for (let trial = 0; trial < 20; trial++) {
      const receiver = await bound(),
        sender = await bound();
      const port = (receiver.address() as { port: number }).port;
      const seen: Buffer[] = [],
        remotePorts: number[] = [];
      let finish!: () => void;
      const delivered = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const guard = setTimeout(finish, 1_000);
      receiver.on("message", (packet, remote) => {
        seen.push(packet);
        remotePorts.push(remote.port);
        if (seen.length === 2) finish();
      });
      const senderPort = (sender.address() as { port: number }).port;
      const session = sessionWith(sender, port);
      session.stopLiveMedia(2, "0".repeat(40), true);
      await session.close();
      await delivered;
      clearTimeout(guard);
      counts.push(seen.length);
      if (seen.length === 2) {
        expect(seen[0]!.subarray(0, 2)).toEqual(RequestMessageType.DATA);
        expect(seen[0]!.readUInt16LE(12)).toBe(1350);
        expect(seen[0]![20]).toBe(2);
        expect(seen[1]!.subarray(0, 2)).toEqual(RequestMessageType.END);
        expect(remotePorts).toEqual([senderPort, senderPort]);
      }
      receiver.close();
    }
    expect(counts).toEqual(Array(20).fill(2));
  }, 30_000);

  it("closes without a peer and tolerates repeated close", async () => {
    const socket = await bound();
    const session = sessionWith(socket);
    await session.close();
    await session.close();
    expect(() => socket.address()).toThrow();
  });

  it("completes close when the END send callback reports an error", async () => {
    const socket = await bound();
    const session = sessionWith(socket, 1234);
    vi.spyOn(socket, "send").mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error) => void;
      queueMicrotask(() => callback(new Error("simulated send failure")));
      return undefined as never;
    });
    await session.close();
    expect(() => socket.address()).toThrow();
  });
});
