# UDP send completion before P2P socket closure

## Need and scope

Closing a P2P session can discard its queued shutdown datagrams. The SDK queues
END and immediately closes the socket; an attached-media STOP queued immediately
before close can also be lost. The API can report successful closure without
sending either packet. This affects the transport lifecycle, independently of
the device model or the application using the SDK.

The change waits for END's send callback on the existing socket before closing
that same socket. The packet format and peer remain unchanged. Send completion means the local send operation finished;
it is not a peer acknowledgement or a guarantee of remote delivery.

## Actual-class loopback reproduction

The regression binds two real UDP sockets on loopback, constructs the actual
`P2PSession`, queues an attached STOP, and immediately awaits `close()`. It checks
both packet headers and that STOP precedes END from the original sender port.
All addresses, account values and station identifiers in the test are synthetic.

| Implementation                | Repetitions | STOP received | END received |
| ----------------------------- | ----------: | ------------: | -----------: |
| Original close implementation |          20 |             0 |            0 |
| Send completion before close  |          20 |            20 |           20 |

The initial reproduction ran on macOS with Node 26.8.1. Linux Node 26.11.1 was
used for the separate operational wire comparison below. These measurements do
not establish behavior on every Node version or operating system.

The receiver waits on packet events with a bounded guard. The upstream test uses
a one-second failure guard per repetition, not a delay in the implementation.
Additional regressions cover asynchronous and synchronous send errors, missing peer,
repeated close, and preserving a replacement socket while the original END send is pending.

The [Node UDP send callback](https://nodejs.org/api/dgram.html#socketsendmsg-offset-length-port-address-callback)
and [socket close callback](https://nodejs.org/api/dgram.html#socketclosecallback)
report different operations. Waiting for close does not replace waiting for send
completion. The actual-class reproduction, rather than an assumption about OS
socket behavior, demonstrates this failure.

## Operational wire comparison

A running service using three P2P sessions was stopped with the original SDK and
with the candidate. Captures retained packet headers only; identities, addresses,
credentials, encrypted command bodies and media are not published.

| Observation                                | Original                        | Candidate         |
| ------------------------------------------ | ------------------------------- | ----------------- |
| Capture packet/drop counters               | 7015 / 0                        | 3470 / 0          |
| Outgoing END datagrams                     | 0                               | 3                 |
| Incoming DATA after the final outgoing END | Not applicable: no END observed | 0 in this capture |

With the original SDK, peer A sent 2947 DATA packets after its last outgoing ACK,
continuing for 7.266929 seconds. Peer B sent 473 after its own last outgoing ACK,
continuing for 7.066436 seconds. These are intervals measured on one wire clock;
they are not intervals after the API returned.

With the candidate, four outgoing DATA packets appeared in the shutdown cluster,
followed by three END datagrams. Their encrypted bodies were not inspected, so
those four packets are not all labeled STOP. The final incoming DATA packets
preceded the last outgoing END; none followed it within the recorded window.
This demonstrates a shutdown-signaling difference. It does not prove receipt of
a particular datagram by the remote device, or permanent silence after capture.

The API observer and wire capture ran on different hosts with approximately
0.4 seconds of clock offset. Cross-host API-to-wire durations are excluded.

## Upstream verification

The regression was also run against unmodified upstream `beta-0.5.0` revision
`425c877`: it failed with zero packets received in all 20 repetitions. With the
close change applied, the full `npm run verify` gate passed on the contributor
pinned Node 24.5.0 and on Node 26.8.1: 247 test files,
4378 tests, 96 documented snippets, formatting, typechecking, architecture guards,
build, ESM load and example typechecks. GNU coreutils and GNU sed were placed
before the macOS system tools in PATH for the shell guards.

## Artifact fingerprints

The initial candidate was isolated from SDK revision
`afcbc3fe5a66d488120dd3d29bcadd1e0eba2c77`; this PR is independently based on
upstream `beta-0.5.0`. Only the close change, its regression and this evidence
record are included. Private raw artifacts are retained for authorized review.

| Artifact                          | SHA-256                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| Initial original bundle           | `1dee01fc12a1cea1c208033c6b630ecbde42039c3279b1563025abbf35fb883c` |
| Initial candidate bundle          | `f78b12fa67caf86ceadac78c3f11b4e960197cefe04c742ef9fc7cbafc414e29` |
| Original actual-class test log    | `e4a784a4c3724bc142f0c4ee95b968a623dd4a241b0bafbe2876815aef53dd61` |
| Candidate focused-test log        | `3518f709dd9ac190a33918d253e51cbb4f86c62a1d9e19b1606710cd96924aed` |
| Original operational wire capture | `cccfd57cbc4248c07e0106c50b8d7f3dac3ba65e50425772cc1a0cdf3010b93f` |
| Playback comparison metadata      | `1dd2509e682c47095d4df94716fbe4f0d0d4e65ede86e921e5770d97bc2d7f39` |
