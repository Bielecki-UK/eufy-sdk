import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

/**
 * The persistent ids a login reports. A successful `LoginResponse` acknowledges the ids its request
 * carried, so they are dropped then; without that the list grows by one id per push for the life of
 * the install and every login sends all of it.
 */
const sockets: EventEmitter[] = [];

vi.mock("node:tls", () => ({
  default: {
    connect: vi.fn(() => {
      const socket = new EventEmitter() as EventEmitter & {
        setKeepAlive: () => void;
        write: () => void;
        destroy: () => void;
      };
      socket.setKeepAlive = () => {};
      socket.write = () => {};
      socket.destroy = () => {};
      sockets.push(socket);
      return socket;
    }),
  },
}));

const { PushClient } = await import("../push-client.js");
const { MessageTag } = await import("../message-tags.js");

type Driven = { onMessage(m: { tag: number; object?: unknown }): void };

function loggedInClient(stored: string[]) {
  const client = new PushClient({ androidId: "1", securityToken: "2" } as never);
  client.setPersistentIds([...stored]);
  client.connect();
  sockets.at(-1)!.emit("secureConnect");
  return client;
}

describe("persistent ids across a login", () => {
  it("drops the ids the login reported once it succeeds, keeping any that arrived after", () => {
    const client = loggedInClient(["0:1", "0:2"]);
    (client as unknown as Driven).onMessage({ tag: MessageTag.DataMessageStanza, object: { persistentId: "0:3" } });
    (client as unknown as Driven).onMessage({ tag: MessageTag.LoginResponse, object: {} });

    expect(client.getPersistentIds()).toEqual(["0:3"]);
    client.close();
  });
});
