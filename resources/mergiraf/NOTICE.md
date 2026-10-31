# Mergiraf

Gnosis distributes Mergiraf 0.20.0 as an independent executable, communicating through ordinary command-line arguments and temporary files.

Mergiraf is Copyright its contributors and licensed under GPL-3.0-only. The complete license is in COPYING. This license applies to Mergiraf, not to Gnosis's separately developed MIT code.

The accompanying mergiraf-source.tar.gz contains the exact upstream source release, Cargo.lock, and build scripts. Extract it and follow its README to build with `cargo build --release --locked`. Cargo.lock identifies the exact dependency source releases available from crates.io; Cargo downloads those sources during the build. Upstream source and release artifacts: https://codeberg.org/mergiraf/mergiraf/releases/tag/v0.20.0

Gnosis does not modify the Mergiraf executable. Its packaging instructions and pinned checksums are in scripts/prepare-mergiraf.mjs and resources/mergiraf/manifest.json in https://github.com/oddur/gnosis.
