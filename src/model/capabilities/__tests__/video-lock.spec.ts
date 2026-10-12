import { describe, expect, it, vi } from "vitest";
import { LOCK, type LockActions } from "../lock.js";
import { bind } from "./bind.js";
import { Device } from "../../device.js";
import type { CommandContext, InboundSignal } from "../types.js";
import type { MediaProvider } from "../../../core/contracts.js";

const ctx: CommandContext = {
  channel: 7,
  codec: "lock",
  deviceType: 55,
  model: "T8530",
  serial: "T8530P0000000000",
  paramIds: new Set([6000]),
  adminUserId: "synthetic-admin",
  shortUserId: "0001",
  accountName: "synthetic-member",
  timezone: "UTC0",
  hasP2p: true,
};
const signal = (payload: unknown, deviceType = 55): InboundSignal => ({
  source: "p2p-frame",
  stationSn: "T8000P0000000000",
  commandId: 1351,
  channel: 7,
  deviceType,
  json: { cmd: 1955, payload },
});

describe("native video lock", () => {
  it.each([
    ["lock", 1],
    ["unlock", 0],
  ] as const)("%s sends one native intent with numeric operation", async (action, operation) => {
    const { acts, sent } = bind<LockActions>("lock", ctx);
    await acts[action]();
    expect(sent).toEqual([
      {
        kind: "set-payload-once",
        cmd: 1961,
        accountId: ctx.adminUserId,
        payload: { shortUserId: "0001", slOperation: operation, userId: ctx.adminUserId, userName: ctx.accountName },
      },
    ]);
  });
  it.each(["adminUserId", "shortUserId", "accountName"] as const)(
    "refuses missing %s before sending",
    async (field) => {
      const { acts, sent } = bind<LockActions>("lock", { ...ctx, [field]: undefined });
      await expect(acts.lock()).rejects.toThrow(/missing member identity/);
      expect(sent).toEqual([]);
    },
  );
  it("withholds ff09 settings and keeps other families unchanged", () => {
    const { acts } = bind<LockActions>("lock", ctx, { ff09Settings: { getAutoLockState: vi.fn() } });
    expect(acts.setAutoLock).toBeUndefined();
    expect(acts.getAutoLockState).toBeUndefined();
    expect(acts.setRainMode).toBeUndefined();
    const other = bind<LockActions>("lock", { ...ctx, deviceType: 189 }).acts;
    expect(other.setAutoLock).toBeTypeOf("function");
    expect(other.refreshStatus).toBeUndefined();
  });
  it.each([3, "3", 4, "4", 5, "5", undefined, false])("reads status %s without guessing a boolean", async (state) => {
    const query = vi.fn().mockResolvedValue({ code: 0, slState: state });
    const { acts } = bind<LockActions>("lock", ctx, { media: { p2pQuery: query } as unknown as MediaProvider });
    await expect(acts.refreshStatus!()).resolves.toBe(
      state === 3 || state === "3" ? false : state === 4 || state === "4" ? true : undefined,
    );
    expect(query).toHaveBeenCalledWith(1955, { payload: { timezone: "UTC0" }, accountId: "synthetic-admin" });
  });
  it("rejects device errors and missing timezone without querying", async () => {
    const query = vi.fn().mockResolvedValue({ code: -106, slState: "3" });
    const media = { p2pQuery: query } as unknown as MediaProvider;
    await expect(bind<LockActions>("lock", ctx, { media }).acts.refreshStatus!()).rejects.toThrow(/-106/);
    query.mockClear();
    await expect(
      bind<LockActions>("lock", { ...ctx, timezone: undefined }, { media }).acts.refreshStatus!(),
    ).rejects.toThrow(/timezone/);
    expect(query).not.toHaveBeenCalled();
  });
  it.each([3, "3", 4, "4"])("decodes %s into canonical state and a semantic event", (state) => {
    const frame = signal({ code: 0, slState: state, slBattery: "66" });
    expect(LOCK.decodeState!(frame)).toEqual({ params: { 6000: String(state), 6001: "66" } });
    expect(LOCK.decodeEvent!(frame)).toEqual({ event: "lockState", payload: { locked: Number(state) === 4 } });
  });
  it.each([null, [], {}, { code: -106, slState: 3 }, { code: "0", slState: 3 }])(
    "ignores malformed/error payload %j",
    (payload) => {
      expect(LOCK.decodeState!(signal(payload))).toBeNull();
      expect(LOCK.decodeEvent!(signal(payload))).toBeNull();
    },
  );
  it("isolates the decoder to type 55 and leaves unknown states unreadable", () => {
    expect(LOCK.decodeState!(signal({ code: 0, slState: 4 }, 189))).toBeNull();
    const dev = Device.fromRecord(ctx.serial!, { deviceType: 55, model: "T8530", params: { 6000: "4" } });
    dev.bindActions(ctx, { dispatch: async () => {} });
    expect(dev.lock?.()?.locked).toBe(true);
    dev.applyParams({ 6000: "5" });
    expect(dev.lock?.()?.locked).toBeUndefined();
    expect(LOCK.decodeEvent!(signal({ code: 0, slState: 5 }))).toBeNull();
  });
});
