# InkBench 2026-08 InkCheck executable archive

This directory preserves the exact `dist/cli.js` bytes used by the corrected
InkBench evidence discussed in chaoz23/inkcheck#215. It is an audit artifact,
not shipped product code, and this branch is not intended to be merged or
released.

## Identity

- InkCheck source commit: `b2651f58080bfcf09713fd95488f155b7624016f`
- InkBench adapter commit: `76b1dd56cb72fb3a877235ff0b57b0424887b190`
- As-run path: `/Users/danstrader/Documents/Codex/2026-07-20/g/work/repos/inkcheck/dist/cli.js`
- Archived filename: `cli.js`
- Size: `77098` bytes
- SHA-256: `b54b01b48122151bc2105c99acbab061e1252da7f3768004d4ad037d0b0290eb`

The same executable digest is recorded by the corrected InkBench cell
artifacts as `0.7.2+cli.b54b01b48122`. Consumers should verify the full digest
before using these bytes. Do not substitute a rebuild when reproducing the
historical evidence; a rebuild is a new executable identity even when its
source commit is unchanged.
