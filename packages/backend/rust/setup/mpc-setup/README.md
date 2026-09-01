# Tokamak zk-EVM MPC Setup

This guide is for developers who contribute to a Tokamak ceremony and operators
who prepare, verify, or finalize its artifacts. Maintainers who need the checked
monomial ranges and transition equations should also read the
[two-phase protocol contract](docs/phase2-output-contract.md).

The implementation has two ceremony phases and two source routes:

```text
Native:
  initialize universal tau
  -> Phase 1 contribution (alpha, x, y)
  -> fix the circuit
  -> Phase 2 contribution (gamma, delta, eta)
  -> final CRS

Dusk-backed:
  verify and adapt pinned Dusk tau          [not a ceremony phase]
  -> prepare universal tau with y = 1
  -> Phase 1 contribution (y)
  -> fix the circuit
  -> Phase 2 contribution (gamma, delta, eta)
  -> final CRS
```

Both routes produce the same typed Phase 1 payload and use the same Phase 2
implementation. The Dusk adaptor supplies the alpha/X basis but does not make a
Tokamak contribution. Each ceremony phase must contain at least one accepted
`random` or `hybrid` contribution before its output can be selected.

## Build modes

Run commands from `packages/backend`.

The default feature uses the local `frontend/qap-compiler` source. A production
build uses the exact npm snapshot and must be compiled with Cargo's release
profile:

```bash
cargo build --locked --release -p mpc-setup \
  --no-default-features --features production-npm-subcircuit-library
```

The binaries are part of the Rust backend workspace and are not standalone
crates.io or npm packages. Application users normally obtain compatible CRS
artifacts through `@tokamak-zk-evm/cli` rather than running a ceremony.

## Participant workflow

The `mpc` binary provides one contribution lifecycle for every route and phase.
The immutable input state determines the contribution profile; `--phase` is an
assertion and cannot override it.

Before requesting entropy, the command verifies the input bundle and displays
the phase and exact profile. It then generates the required secret shares,
updates the bound point families, creates proofs, verifies its own transition,
erases temporary secret material, and atomically commits a new bundle.

```bash
cargo run --locked --release -p mpc-setup --bin mpc -- contribute \
  --phase 1 \
  --input /path/to/previous-state \
  --output /path/to/my-contribution
```

Optional participant entropy may be mixed with system randomness:

```bash
  --seed-input 'participant-provided entropy'
```

`--beacon-mode` requires `--seed-input`. It creates a deterministic,
cryptographically verifiable receipt, but the receipt is explicitly
non-qualifying and cannot satisfy a phase's minimum contribution requirement.

Verify a handoff independently:

```bash
cargo run --locked --release -p mpc-setup --bin mpc -- verify-transition \
  --previous /path/to/previous-state \
  --current /path/to/current-state \
  --receipt /path/to/current-state/receipt.json
```

Participant identity and device metadata are not cryptographic authority. State
and receipt digests identify a transition. Participants should erase their
secret shares and local entropy after successful self-verification and handoff.

## Operator workflow

Every output path below is immutable and must not already exist. The workspace
is append-only and re-verifies the complete chain before selection or append.

### Native Phase 1

```bash
mpc initialize-native \
  --ceremony-id example-ceremony \
  --qap /path/to/qap \
  --output /path/to/phase1-genesis

mpc workspace-init \
  --workspace /path/to/ceremony-workspace \
  --initial /path/to/phase1-genesis
```

Distribute the genesis to a participant, receive a contributed bundle, verify
it, and append it:

```bash
mpc verify-transition \
  --previous /path/to/phase1-genesis \
  --current /path/to/phase1-contribution \
  --receipt /path/to/phase1-contribution/receipt.json

mpc workspace-append \
  --workspace /path/to/ceremony-workspace \
  --bundle /path/to/phase1-contribution
```

Repeat the contribution and append steps as required. The same person may
contribute more than once or to both phases; no distinct-identity minimum is
enforced. Selection requires at least one qualifying receipt and relies on the
contributor erasing every share they generate.

### Dusk-backed Phase 1

The adaptor reads or downloads the repository-pinned Dusk response, verifies
its pinned SHA-256 and the required G1/G2 tau sequences, and reindexes the used
powers into an `AdaptedTau` bundle. It creates no Tokamak secret or receipt.

```bash
mpc adapt-dusk \
  --qap /path/to/qap \
  --raw /path/to/dusk.response \
  --output /path/to/adapted-tau

mpc prepare-dusk \
  --ceremony-id example-ceremony \
  --qap /path/to/qap \
  --adapted-tau /path/to/adapted-tau \
  --output /path/to/phase1-prepared

mpc workspace-init \
  --workspace /path/to/ceremony-workspace \
  --initial /path/to/phase1-prepared
```

Participants then use the common `mpc contribute --phase 1` command. The state
selects the `DuskY` profile, which changes Y-dependent families and preserves
the adapted alpha/X basis.

The pinned source identity is maintained in `src/alpha_x_basis.rs`. Operators
must not substitute a different source by editing an artifact or manifest.

### Circuit fixation and Phase 2

After a qualifying Phase 1 state has been appended, deterministic preparation
commits the concrete R1CS/QAP input and creates the initial Phase 2 bundle:

```bash
mpc prepare-circuit \
  --workspace /path/to/ceremony-workspace \
  --qap /path/to/qap \
  --output /path/to/phase2-prepared

mpc workspace-append \
  --workspace /path/to/ceremony-workspace \
  --bundle /path/to/phase2-prepared
```

Participants use the same command shape with `--phase 2`. The authenticated
state selects `CircuitGammaDeltaEta`.

```bash
mpc contribute \
  --phase 2 \
  --input /path/to/phase2-prepared \
  --output /path/to/phase2-contribution

mpc workspace-append \
  --workspace /path/to/ceremony-workspace \
  --bundle /path/to/phase2-contribution
```

Reverify the complete workspace at any handoff or restart boundary:

```bash
mpc workspace-verify --workspace /path/to/ceremony-workspace
```

### Final local CRS

Finalization requires a selected qualifying Phase 2 state. A Dusk-backed
workspace must also supply its authenticated adaptor bundle; a native workspace
must not supply one.

```bash
# Native
mpc generate-final \
  --workspace /path/to/ceremony-workspace \
  --output /path/to/final-crs

# Dusk-backed
mpc generate-final \
  --workspace /path/to/ceremony-workspace \
  --adapted-tau /path/to/adapted-tau \
  --output /path/to/final-crs
```

Finalization builds `ceremony_transcript.json` in the ceremony workspace,
recomputes it from the complete verified chain, and binds its SHA-256 into final
provenance. The final CRS directory contains exactly:

- `combined_sigma.rkyv`
- `sigma_preprocess.rkyv`
- `sigma_verify.json`
- `crs_provenance.json`

The complete transcript, receipts, state manifests, adaptor manifest, and point
chunks remain in the separate ceremony workspace and adaptor bundle.

## Automated single-contributor wrappers

`native_mpc_setup` and the `ceremony` subcommand of
`dusk_backed_mpc_setup` run the same state machine locally with one contributor
per phase. They are convenience wrappers, not a different protocol.

```bash
cargo run --locked --release -p mpc-setup --bin native_mpc_setup -- \
  --intermediate ./setup/mpc-setup/output/native.intermediate \
  --output ./setup/mpc-setup/output/native.final
```

Create a Dusk-backed CRS from the production npm snapshot without publishing
it:

```bash
cargo run --locked --release -p mpc-setup --no-default-features \
  --features production-npm-subcircuit-library --bin dusk_backed_mpc_setup -- \
  ceremony \
  --intermediate ./setup/mpc-setup/output/dusk.intermediate \
  --output ./setup/mpc-setup/output/dusk.final
```

The intermediate root contains `ceremony-workspace`, and Dusk-backed mode also
contains `adapted-tau` and the pinned raw `dusk.response`.

`dusk_backed_mpc_setup publish` publishes an already generated eligible CRS.
`dusk_backed_mpc_setup run` performs ceremony followed by publication. These
meanings are unchanged; `ceremony` alone never publishes. Publication also
requires the production npm subcircuit-library origin, verified artifact
digests, configured Drive credentials, and folder permissions.

The integrated production command is:

```bash
cargo run --locked --release -p mpc-setup --no-default-features \
  --features production-npm-subcircuit-library --bin dusk_backed_mpc_setup -- \
  run \
  --intermediate ./setup/mpc-setup/output/dusk.intermediate \
  --output ./setup/mpc-setup/output/dusk.final
```

The default-feature command is a development-only local-source ceremony:

```bash
cargo run --locked --release -p mpc-setup --bin dusk_backed_mpc_setup -- \
  ceremony \
  --intermediate ./setup/mpc-setup/output/dusk-local.intermediate \
  --output ./setup/mpc-setup/output/dusk-local.final
```

It records `localQapCompiler` provenance and remains publication-ineligible.
Rebuilding a later `publish` command with the production feature cannot convert
that local-source artifact into an npm-snapshot artifact.

## Recovery and compatibility

State bundles are written into sibling temporary directories, self-verified,
and renamed only after verification. Existing output paths are never
overwritten. A restart is valid only from an immutable bundle already appended
to a workspace whose full chain passes `workspace-verify`.

The current protocol is `tokamak-mpc-2phase-v1`. Legacy `phase1_acc_*`,
`phase1_proof_*`, `SigmaV2`, and `phase2_acc_*` files are incompatible. There
is no converter or fallback: restart a native ceremony or rerun the Dusk
adaptor.

## Provenance and security-claim boundary

`crs_provenance.json` records the backend compatibility class, the exact
subcircuit-library identity and source digest, the Phase 1 source, the ceremony
protocol version, the transcript SHA-256, and the three final artifact digests.
`releaseEligible` is a publication gate, not an algorithm compatibility test.

The implemented checks establish artifact integrity, transition consistency,
proof binding, source mapping, and qualifying-contribution policy. The
literature-backed [protocol publication](../../../docs/publication/tokamak-mpc-protocol.md)
describes which claims depend on each trapdoor family remaining unknown and
which integrity properties remain independently verifiable. Do not infer a
complete trust or toxic-waste claim solely from a successful transition check.

## License

The MPC setup implementation and documentation are dual-licensed under
`MIT OR Apache-2.0`.
