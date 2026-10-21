# Live consumer reference continuity

## Defect and scope

An ordinary consumer joining a warm shared source received only its retained keyframe followed by current dependent pictures. Pictures between that keyframe and attachment were omitted. Their reference chain therefore was not guaranteed, for either H.264 or H.265. This is a consumer bootstrap defect; it does not establish packet loss or a camera defect.

Ordinary attachment now waits for the next live keyframe using the existing per-consumer resynchronization gate. It does not restart the shared source, add a steady-state buffer, change codec/quality, or affect other consumers. Explicit recording prebuffer attachment still takes its complete keyframe-aligned snapshot without that gate. Snapshots follow their existing live collection branch instead of the cached-prime shortcut.

## Captured failure and controlled replay

A privately retained complete Matroska producer input contained 120 pictures. It began with an IDR, followed at 1.371 seconds by a dependent picture referencing missing picture-order-count 38; the next intact IDR was packet 11 at 2.034 seconds. Software decoding reported a missing reference and decoded 110 pictures.

The controlled hardware decode-only comparison stopped concurrent media workloads and preserved original coded bytes. Removing only the first 11 picture clusters, starting at the next IDR, produced 109 clean pictures in 2.24 seconds. The original input took 17.74 seconds and caused a kernel GPU hang with the missing-reference diagnostic. The same filtered input then produced 109 clean pictures in 2.27 seconds without another GPU hang. No video processing, encoding, or concurrent decoder was necessary to reproduce the original failure.

This replay establishes that the invalid bootstrap can trigger the observed hardware failure on the tested decoder/driver combination. It does not prove every hardware decoder fails similarly, or establish the provenance of that retained first IDR: comparison against the preceding producer found no identical coded picture. The shared source remained active between producers. The independent installed-SDK late-join observation below directly establishes cached-prime provenance for its own fixture.

## Regression checks

Synthetic H.264 and H.265 joins place two dependent pictures between the retained IDR and attachment. They require no output until the next live IDR and then uninterrupted delivery of its dependent picture. Readable receipt metadata must describe that live picture, not the aged retained keyframe. These assertions fail against the original implementation. Existing recording-prebuffer alignment tests remain part of the focused suite.

Private media, identities, addresses, and raw GPU buffers are deliberately excluded. The short controlled live verification is recorded below; sustained operation remains a separate gate.

## Installed SDK late-join provenance

A bounded observer attached one local consumer to an already active shared source, without another camera session. Its first delivered frame matched the source cache exactly by coded SHA-256, source timestamp, source identity, and receipt sequence. At attachment that receipt was 622,991 microseconds old. The next delivered dependent picture had receipt sequence 16 positions later: 15 intervening video receipts were omitted. This directly reproduces the SDK join discontinuity rather than inferring it from a transport gap.

The resulting private fixture SHA-256 is `d1d8b257b9c7ae492aec1428bc7477e0858c8199bccae0aef01a6373d4690d69`. Its cached first-picture SHA-256 is `0a46278668431d90328428ffd653c81c718bfa4c9f563e1b6f725303d95f1b40`. The fixture contains 97 coded packets; ordinary software decoding produced 83 frames, while strict decoding produced zero and exited 183. No real source identity or media is included here.

Candidate bundle SHA-256: `569200ac0f3a504efba46bca33962e82be96034776542b37f171b6e379d1d0ab`. The short controlled live result is recorded below.

Replay input SHA-256: `217abf10cfc4c957a8415225ece5ee8372d61ba117245347556985857bd30008`. Verbatim filtered suffix SHA-256: `add430fc1a9bf79e62cd19cfbaea6c61869b078a23e1860ca93d3edee37dbb14`. Private GPU dump SHA-256: `0cb9da825dd989fa438f06cf61463d7efc89603a8187785752c23fa176213585`.

## Controlled live candidate verification

The installed candidate attached a local consumer mid-GOP to an existing active source. The cached receipt at attachment had sequence 665. It was not delivered (`consumerPrimed` was false). The first delivered item was a fresh live IDR at sequence 695, followed by dependent pictures 696 and 697. This verifies the gate at the actual SDK consumer boundary.

The candidate fixture contains 90 coded packets. Both ordinary and strict software decoding returned zero, decoded all 90 pictures, and produced no diagnostics. Its SHA-256 is `d591805073530e193ac9ee638488b1acf93e8d1a14b004d5126dbf1921258e64`. The earlier observer attempt reached its deadline without receiving a target-source frame and produced no fixture; it is excluded from this comparison.

The candidate was installed at 2026-10-21 00:40:30 UTC. Hardware-first decoding/encoding and coded quality settings were unchanged. The short canary passed; the ten-minute sustained-operation check began around 00:43 UTC and was still running when this record was written. The record does not claim sustained playback is complete or that every source pause has been eliminated.

## Verification and upstream scope

Focused join, receipt, prebuffer, snapshot, and configuration tests pass. The full SDK suite passes 4,145 tests across 238 files, and typechecking and the bundle build pass. The new join/receipt assertions fail against the original source (three failures). Snapshot/configuration fixtures were updated to supply live keyframes rather than relying on the removed ordinary cached-prime behavior.

The change applies to shared-source consumers independently of camera model, codec, decoder, and host application. The demonstrated hardware consequence is limited to the tested HEVC decoder/driver. No new public option, transport command, decoder policy, or buffering mechanism was added. Public consumer fields remain available; explicit recording prebuffer attachment is unchanged.

Open and closed upstream pull requests and issues were searched for keyframe, prime, and SharedLiveSource changes. No equivalent late-join continuity fix was found. Related keyframe-flag and source-retry proposals address different defects. Upstream PR #478 currently has changes requested, so the repository contribution rules block opening another PR until that review is addressed. This candidate is a local handoff only; it does not modify PR #478 or open another PR.
