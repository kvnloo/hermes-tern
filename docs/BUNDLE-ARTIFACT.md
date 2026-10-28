# Candidate frontend bundle

The `bundle candidate` workflow builds a candidate `entry.js` from one exact plugin commit
and the Hermes commit in that commit's `frontend/hermes-src.lock`. It uploads the
bundle and `provenance.json` as a GitHub Actions artifact for seven days. The
receipt records the two source commits, bundle SHA-256 and byte count. It is a
build receipt, not a test, native-host or release attestation.

Find the run for the intended commit on the Actions page, download its
`hermes-tern-bundle-<plugin SHA>` artifact, and independently check the SHA-256
and size against the receipt before any isolated evaluation. Check the run's
source and conclusion as well: a pull-request or manually dispatched run can
build a revision that is not current main. The receipt does not prove that
downloaded bytes are trustworthy if the receipt itself is untrusted.

The candidate workflow does not push to main or install the artifact; the existing
`bundle` workflow is unchanged. The checked-in
`frontend/dist/entry.js` remains the file used by a normal plugin install; it can
therefore remain stale. Releasing updated bytes, choosing a distribution path,
and validating an actual installed plugin and Tern window are separate steps.
The regular checks workflow remains responsible for source tests.
