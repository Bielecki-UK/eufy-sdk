import { afterEach, describe, expect, it, vi } from "vitest";
import { connectedSession, routerWithSession, DEVICE_SN, ACCOUNT_ID } from "./session-fixtures.js";

function harness() {
  const session = Object.assign(connectedSession(), { sendControlLevel2: vi.fn(() => true) });
  const router = routerWithSession(session);
  return { session, router };
}
const frame = (channel = 1, cmd = 1955, payload: unknown = { code: 0, slState: "4" }) => ({
  commandId: 1351,
  channel,
  json: { cmd, payload },
});
afterEach(() => vi.useRealTimers());

describe("one-shot level-2 payload", () => {
  it.each([0, 1])("sends operation %s exactly once on the resolved channel with mValue3=0", async (slOperation) => {
    vi.useFakeTimers();
    const { session, router } = harness();
    const payload = { shortUserId: "0001", slOperation, userId: ACCOUNT_ID, userName: "synthetic-member" };
    await router.dispatchCommand(DEVICE_SN, { kind: "set-payload-once", cmd: 1961, accountId: ACCOUNT_ID, payload });
    await vi.advanceTimersByTimeAsync(10000);
    expect(session.sendControlLevel2).toHaveBeenCalledExactlyOnceWith(1961, 1, ACCOUNT_ID, payload, 0);
    expect(session.listenerCount("commandResult")).toBe(0);
  });
  it("reports send failure without retry", async () => {
    const { session, router } = harness();
    session.sendControlLevel2.mockReturnValue(false);
    await expect(
      router.dispatchCommand(DEVICE_SN, { kind: "set-payload-once", cmd: 1961, accountId: ACCOUNT_ID, payload: {} }),
    ).rejects.toThrow(/send failed/);
    expect(session.sendControlLevel2).toHaveBeenCalledTimes(1);
  });
  it("requires member identity before sending", async () => {
    const { session, router } = harness();
    await expect(
      router.dispatchCommand(DEVICE_SN, { kind: "set-payload-once", cmd: 1961, accountId: "", payload: {} }),
    ).rejects.toThrow(/identity/);
    expect(session.sendControlLevel2).not.toHaveBeenCalled();
  });
  it("matches status by outer command, inner command and channel, never generic success", async () => {
    const { session, router } = harness();
    session.sendControlLevel2.mockImplementation(() => {
      session.emit("commandResult", { code: 0, channel: 1 });
      session.emit("data", frame(2));
      session.emit("data", frame(1, 1940));
      session.emit("data", { ...frame(), commandId: 1350 });
      session.emit("data", frame(1, 1955, []));
      queueMicrotask(() => session.emit("data", frame()));
      return true;
    });
    await expect(router.p2pQuery(DEVICE_SN, 1955, { payload: { timezone: "UTC0" } })).resolves.toEqual({
      code: 0,
      slState: "4",
    });
    expect(session.sendControlLevel2).toHaveBeenCalledExactlyOnceWith(1955, 1, ACCOUNT_ID, { timezone: "UTC0" }, 0);
    expect(session.listenerCount("data")).toBe(0);
    expect(session.listenerCount("close")).toBe(0);
  });
  it("preserves the correctly attributed negative status result", async () => {
    const { session, router } = harness();
    session.sendControlLevel2.mockImplementation(() => {
      queueMicrotask(() => session.emit("data", frame(1, 1955, { code: -106 })));
      return true;
    });
    await expect(router.p2pQuery(DEVICE_SN, 1955, { payload: { timezone: "UTC0" } })).resolves.toEqual({ code: -106 });
    expect(session.listenerCount("data")).toBe(0);
  });
  it.each(["timeout", "close", "send"])("cleans up after %s failure", async (failure) => {
    vi.useFakeTimers();
    const { session, router } = harness();
    if (failure === "send")
      session.sendControlLevel2.mockImplementation(() => {
        throw new Error("send failure");
      });
    const result = router.p2pQuery(DEVICE_SN, 1955, { payload: { timezone: "UTC0" }, timeoutMs: 20 });
    const assertion = expect(result).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1);
    if (failure === "close") session.emit("close");
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(session.listenerCount("data")).toBe(0);
    expect(session.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
  });
  it("refuses overlapping identical queries and releases the guard on completion", async () => {
    vi.useFakeTimers();
    const { session, router } = harness();
    const first = router.p2pQuery(DEVICE_SN, 1955, { payload: { timezone: "UTC0" } });
    await vi.advanceTimersByTimeAsync(1);
    await expect(router.p2pQuery(DEVICE_SN, 1955, { payload: { timezone: "UTC0" } })).rejects.toThrow(
      /already pending/,
    );
    session.emit("data", frame());
    await first;
    expect(session.sendControlLevel2).toHaveBeenCalledTimes(1);
  });
});
