/**
 * The portal's data-channel keepalive for an RTC session.
 *
 * {@link PORTAL_KEEPALIVE} is the 36 bytes the portal sends unframed on the data channel — a 20-byte
 * prefix then a bare `XZYH 1139`, no portal packet header — and the hub echoes it. Sent every
 * {@link PORTAL_KEEPALIVE_MS}, it stops the hub idling the session out.
 */

/** The portal's 36-byte data-channel keepalive: a 20-byte prefix and a bare `XZYH 1139`. */
export const PORTAL_KEEPALIVE = Buffer.from(
  "0009000010000000000000006300000000000000585a5948730400000000000000000002",
  "hex",
);

/** How often {@link PORTAL_KEEPALIVE} goes out on an RTC session. */
export const PORTAL_KEEPALIVE_MS = 29_000;

/** The keepalive's leading bytes, which the hub's echo repeats; neither a PTCS nor a portal packet opens so. */
const ECHO_LEAD = PORTAL_KEEPALIVE.subarray(0, 8);

/**
 * True for the hub's echo of {@link PORTAL_KEEPALIVE}: an unframed message of the keepalive's 36 bytes
 * that opens with its leading bytes `0009000010000000`.
 */
export function isPortalKeepaliveEcho(message: Buffer): boolean {
  return message.length === PORTAL_KEEPALIVE.length && message.subarray(0, ECHO_LEAD.length).equals(ECHO_LEAD);
}
