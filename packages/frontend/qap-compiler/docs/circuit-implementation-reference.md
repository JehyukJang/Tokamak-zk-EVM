# Circuit Implementation and Composition Reference

## What this document explains

Tokamak zk-EVM proves that an Ethereum Virtual Machine (EVM) transaction was
executed correctly without asking the verifier to execute the transaction
again. The proof circuit is not written as one monolithic program. It is built
from smaller **subcircuits**, each of which handles a particular relation such
as addition, comparison, hashing, signature arithmetic, or movement across a
public input/output boundary.

This document explains every subcircuit built from the current qap-compiler
source. For each one, it answers five questions:

1. What operation does it perform?
2. How many constraints does it contain?
3. How many input and output wires does it expose?
4. Which wires are public and which remain private?
5. Is the subcircuit sufficient by itself, or does it rely on a particular
   composition with other subcircuits?

The intended audience is any reader who needs to understand the circuit
library, including application developers, auditors, integrators, and new
contributors. The detailed tables remain useful to circuit maintainers, but
no prior knowledge of this repository is assumed.

## Where the subcircuits fit

The qap-compiler directory contains Circom source and tools for producing the
prebuilt subcircuit library. The directory name is historical; users receive
the artifacts through the `@tokamak-zk-evm/subcircuit-library` package. A
separate **composition layer** selects the required subcircuits and records how
their wires must be connected. The proving system then uses those placements
and connections as one composed circuit. A verifier sees only the final proof
and the wires that the composed interface declares public.

```mermaid
flowchart LR
    statement["Operation or execution statement"] --> composer["Composition layer: select and connect placements"]
    library["Subcircuit library: constraints and witness generators"] --> composer
    composer --> composed["One composed proof circuit"]
    composed --> proof["Proof plus public inputs and outputs"]
    proof --> verifier["Verifier"]
```

This distinction matters for security. A compiled subcircuit is a reusable
module, not normally a complete proof statement. Some modules are deliberately
split to stay small. For example, EVM division is implemented by `ALU4A`
followed by `ALU4B`; neither half proves division by itself. The final
permutation must connect the exact outputs of the first half to the exact
inputs of the second half.

Most users should therefore consume the synchronized package through a
supported composition layer, CLI, or proving backend. They should not select
individual R1CS files and treat them as standalone proofs.

## Terms used in this document

| Term | Meaning here |
| --- | --- |
| EVM word | One 256-bit bit pattern used by the EVM. Signed opcodes interpret the same pattern using two's-complement notation. |
| Limb | Half of an EVM word. This library represents one 256-bit word as two 128-bit limbs. |
| Wire | One scalar-field value entering, leaving, or connecting circuit constraints. A 256-bit word therefore occupies two physical wires. |
| Constraint | An algebraic equation that a valid witness must satisfy. More constraints generally mean more proving work, but the count is not a security score. |
| R1CS | Rank-1 constraint system, the compiled algebraic form consumed by setup and proving. |
| Witness | The complete set of public and private wire values used to satisfy the circuit. |
| Public wire | A value bound to the final proof statement and available to the verifier. |
| Private wire | A witness value hidden from the verifier. Private does not mean unconstrained. |
| Placement | One use of a subcircuit in the circuit generated for a transaction. |
| Permutation | The final wire connections that make one placement's output equal another placement's input. |
| Canonical representation | The unique allowed limb encoding of an integer or field element. |
| Soundness | The property that satisfying the constraints is enough to establish the operation claimed by the circuit contract. |

## How to interpret the soundness status

The status describes the current source-level relation under the composition
model used by Tokamak zk-EVM:

- **Locally sound** means the subcircuit itself enforces the listed operation
  for its declared input representation. It still needs normal wire routing,
  but it has no mandatory partner circuit.
- **Composition-dependent** means the system claim is sound only when the
  composition layer and final permutation enforce the exact producer, consumer,
  ordering, or public-boundary contract stated in this document.
- **Incomplete** means known constraint work remains in the current source.
  The normal composition topology alone is not enough to claim soundness for
  that operation.

An `Incomplete` row is a warning about the repository state described by this
page, not a conclusion about every previously published npm release. A release
must be evaluated using the source, generated artifacts, and setup material
from that same version. Never mix artifacts from different versions.

This page is an engineering reference, not a formal proof or third-party
security certification. It reports composition dependencies explicitly so
that a property enforced by another subcircuit or by the verifier boundary is
not mistakenly attributed to an isolated artifact.

## Three representative examples

### A self-contained arithmetic operation

For `ADD`, the composition layer places `ALU1` with the `ADD` selector and two EVM
words. `ALU1` checks the limb ranges, constrains the addition, and returns one
canonical EVM word. No second arithmetic subcircuit is required, so the row is
marked locally sound.

### An operation split across two subcircuits

For `DIV`, the composition layer must place `ALU4A` and `ALU4B` in that order.
`ALU4A` prepares the quotient, remainder, magnitude, and mode information;
`ALU4B` checks the remaining division relation and produces the EVM result.
The pair is sound only if all 13 intermediate wires are connected exactly, so
both rows are marked composition-dependent.

### A public boundary

`bufferTxIn` copies public transaction-input wires to private internal wires.
The verifier can see the public side, while later computation uses the private
side. `bufferPrvIn` is different: both sides remain private because it carries
private witness data. Buffer constraints prove equality across the boundary;
the surrounding protocol assigns meaning to the values.

## How the rest of this page is organized

- **Buffer subcircuits** lists the modules that cross the final public/private
  boundary and explains the type and capacity of each buffer.
- **Computational subcircuits** lists arithmetic, comparison, hashing,
  signature, conversion, and equality modules.
- **Mandatory and conditional composition contracts** expands every table row
  whose security or full operation semantics depend on another placement or
  on a restricted producer.
- **Update checklist** tells maintainers which synchronized artifacts and
  contracts must be reconsidered when the implementation changes.

## Scope and source snapshot

The tables cover every production target in
[`scripts/compile.sh`](../scripts/compile.sh). Files under
`subcircuits/circom/unused/` are historical or experimental and are not
included. The values describe the current source tree, not necessarily the
contents of an older installed package or the checked-in generated library.

Constraint counts were measured from the current source with Circom 2.2.3,
explicit O2 optimization, the BLS12-381 scalar field, and the
production target list in `scripts/compile.sh`. A total is the sum of the
reported nonlinear and linear constraints. Re-run the production compile
before relying on these numbers after any source or constant change.

O2 may eliminate a private signal that is used only through linear relations.
Every compiled subcircuit wrapper therefore exposes its intended physical
inputs as temporary public inputs to Circom. The final composition layer still
assigns actual proof visibility; this standalone compiler annotation exists
only to preserve every reviewed subcircuit interface wire during O2.

Wire counts are physical scalar-field wires. Interface counts do not include
the local constant-one wire. Every 256-bit word uses this order:

1. lower 128-bit limb
2. upper 128-bit limb

Visibility refers to the final composed proof interface constructed by
[`scripts/parse.js`](../scripts/parse.js) and
[`scripts/configure.js`](../scripts/configure.js), not to the temporary
standalone visibility used while Circom compiles one wrapper. All non-buffer
interfaces are private internal wires. The public side of each buffer is
selected explicitly by `PUBLIC_WIRE_SEGMENTS`.

## Buffer subcircuits

Every buffer is a `Buffer2` equality boundary: it constrains each output wire
to equal the corresponding input wire and adds a nonlinear constraint to keep
both columns represented in the R1CS. That copy relation is locally sound.
The semantic type, capacity, padding interpretation, and public-format checks
are composition or higher-protocol responsibilities.

A buffer capacity is the number of physical input wires accepted by its
`Buffer2` instance. The buffer exposes the same number of output wires, but
those outputs are not added to the capacity. Buffers do not impose one common
logical value type: a native field value or one-limb value occupies one input
wire, while a 256-bit EVM word occupies two 128-bit-limb input wires. Mixed
values therefore consume capacity according to their actual physical wire
layouts after expansion by the composition layer.

| Subcircuit | Role and current capacity | Constraints (nonlinear + linear = total) | Final interface visibility | Soundness contract |
| --- | --- | ---: | --- | --- |
| `bufferLogOut` | Committed EVM log output; 50 input wires | 50 + 50 = 100 | 50 private inputs -> 50 public outputs | Local equality; the higher protocol interprets tuple layout and all-zero padding. |
| `bufferStorageStore` | Final storage writes; 30 input wires | 30 + 30 = 60 | 30 private inputs -> 30 public outputs | Local equality; triples must be routed as address, key, value. |
| `bufferStorageLoad` | Initial storage reads; 40 input wires | 40 + 40 = 80 | 40 private inputs -> 40 public outputs | Local equality; triples must be routed as address, key, value. |
| `bufferTxIn` | Transaction inputs; 6 input wires | 6 + 6 = 12 | 6 public inputs -> 6 private outputs | Local equality plus public-boundary format checking. |
| `bufferBlockIn` | Block fields and previous block hashes; 24 input wires | 24 + 24 = 48 | 24 public inputs -> 24 private outputs | Local equality plus public-boundary format checking. |
| `bufferEVMIn` | Fixed EVM inputs and constants; 530 input wires | 530 + 530 = 1,060 | 530 public inputs -> 530 private outputs | Local equality plus public-boundary format checking. |
| `bufferPrvIn` | Private witness inputs; 80 input wires | 80 + 80 = 160 | 80 private inputs -> 80 private outputs | Local equality; it is intentionally absent from `PUBLIC_WIRE_SEGMENTS`. |

Public-output buffers are fixed-capacity and zero-padded. The higher-level
protocol filters storage entries with a zero address and log entries whose
fields are all zero. The buffer circuits do not perform those semantic checks.

## Computational subcircuits

In the interface descriptions below, `word` means two physical 128-bit limb
wires and `bit` means one scalar-field wire constrained to be boolean where the
stated local relation requires it. All interfaces in this table are private
inside the final composed proof; the verifier does not receive each arithmetic
input and intermediate result as a separate public value.

| Subcircuit | Operation or role | Constraints (nonlinear + linear = total) | Private interface | Status |
| --- | --- | ---: | --- | --- |
| `ALU1` | `ADD`, `MUL`, `SUB`, `EQ`, `ISZERO`, `NOT` selected by the EVM selector | 963 + 0 = 963 | 5 inputs: selector, two words; 2 outputs: one word | Locally sound. The wrapper constrains both input words, the selected result, and supported selectors. Unary operations receive a constrained zero second operand from the composition definition. |
| `ALU2` | Unsigned `LT`, `GT` | 780 + 1 = 781 | 5 inputs: selector, two words; 2 outputs: one word | Locally sound. Both words are canonical and the selector is restricted to the two supported values. |
| `ALU3` | Signed `SLT`, `SGT` | 780 + 1 = 781 | 5 inputs: selector, two words; 2 outputs: one word | Locally sound. Both words and their sign bits are constrained locally. |
| `AND` | Bitwise `AND` | 768 + 1 = 769 | 5 inputs: selector, two words; 2 outputs: one word | Locally sound. Both operands are bit-decomposed and the selector is fixed. |
| `OR` | Bitwise `OR` | 768 + 1 = 769 | 5 inputs: selector, two words; 2 outputs: one word | Locally sound. Both operands are bit-decomposed and the selector is fixed. |
| `XOR` | Bitwise `XOR` | 768 + 1 = 769 | 5 inputs: selector, two words; 2 outputs: one word | Locally sound. Both operands are bit-decomposed and the selector is fixed. |
| `ALU4A` | First half of `DIV`, `MOD`, `SDIV`, `SMOD` | 673 + 0 = 673 | 5 inputs: selector, dividend word, divisor word; 13 outputs | Composition-dependent; never use as an independent EVM operation. It must be followed by `ALU4B` with all 13 outputs connected exactly. |
| `ALU4B` | Second half of `DIV`, `MOD`, `SDIV`, `SMOD` | 802 + 0 = 802 | 13 inputs; 2 outputs: one word | Composition-dependent; never use independently. Its inputs must be the exact `ALU4A` outputs from the same operation. |
| `SIGNEXTEND` | Full-domain EVM `SIGNEXTEND` | 637 + 1 = 638 | 5 inputs: selector, index word, value word; 2 outputs: one word | Locally sound, including indices greater than or equal to 32. |
| `BYTE` | Full-domain EVM `BYTE` | 546 + 2 = 548 | 5 inputs: selector, index word, value word; 2 outputs: one word | Locally sound, including indices greater than or equal to 32. |
| `SHL` | Full-domain EVM logical left shift | 921 + 1 = 922 | 5 inputs: selector, shift word, value word; 2 outputs: one word | Locally sound, including shifts greater than or equal to 256. |
| `ALU6` | Full-domain EVM `SHR`, `SAR` | 942 + 0 = 942 | 5 inputs: selector, shift word, value word; 2 outputs: one word | Locally sound. `SHR` and `SAR` share the constrained right-shift core; `SAR` adds sign fill locally. |
| `CheckBus256` | Proves that both limbs form a canonical 256-bit word | 256 + 0 = 256 | 2 inputs: one word; no outputs | Locally sound as a range assertion. It is also a mandatory support placement for the first operand of `ADDMOD` and `MULMOD`. |
| `ADDMOD` | EVM full-precision addition followed by modular reduction | 832 + 1 = 833 | 7 inputs: selector, three words; 2 outputs: one word | **Incomplete.** It also requires an adjacent `CheckBus256` on the exact first operand, but that topology does not resolve the outstanding local modular-reduction soundness work. |
| `MULMOD` | EVM full-precision multiplication followed by modular reduction | 844 + 1 = 845 | 7 inputs: selector, three words; 2 outputs: one word | **Incomplete.** It also requires an adjacent `CheckBus256` on the exact first operand, and the current local full-product/reduction relation still requires remediation. |
| `DecToBit` | Decomposes one canonical 256-bit word into 256 LSB-first bits | 256 + 2 = 258 | 2 inputs: one word; 256 bit outputs | Locally sound. It supplies exponent or scalar bits to composed exponentiation chains. |
| `SubExpBatch` | Eight LSB-first square-and-multiply steps for EVM `EXP` | 328 + 0 = 328 | 12 inputs: accumulator word, base-power word, 8 bits; 4 outputs: next accumulator and base-power words | **Incomplete.** The intended chain is defined below, but the current unsafe multiplication relation and bus contract still require local remediation. |
| `Accumulator` | Adds 32 256-bit memory-slice words | 318 + 0 = 318 | 64 inputs: 32 words; 2 outputs: one word | Composition-dependent and pending hardening. Every input must come from the approved canonical shift-and-mask path, and the composition must exclude overflow; direct unchecked producers are not allowed. |
| `Poseidon` | Selector-chosen chain of two-input Poseidon compressions; current batch size is 1 | 238 + 1 = 239 | 5 inputs: selector and two split 255-bit values; 2 outputs: one split 255-bit value | Composition-dependent for canonical split-field encoding. The hash relation is local, but unique 255-bit encodings must be guaranteed by connected producers or the public-boundary verifier. |
| `FrToLimbsPair` | Converts two independent native BLS12-381 scalar-field values to lower-first two-limb EVM words | 1,022 + 2 = 1,024 | 2 native-field inputs; 4 outputs: two lower-first limb pairs | Locally sound as two canonical conversions. Each input is constrained to its unique integer representation `0 ≤ x < Fr`; the circuit is general-purpose and not specific to transaction signatures. |
| `TransactionSignaturePoseidonBatch4` | Performs either four consecutive native-field Poseidon compressions or one independent compression plus a three-compression chain | 950 + 0 = 950 | 7 inputs: mode and six native field wires; 2 native-field outputs | Composition-dependent. Mode is locally Boolean, but the composition must assign the approved structural mode and connect every chain state exactly. |
| `TransactionSignatureCanonicalFrView` | Produces the unique 255-bit decomposition and lower-first two-limb EVM view of one native BLS12-381 scalar-field value | 511 + 3 = 514 | 1 native-field input; 257 outputs: 255 bits and 2 limbs | Locally sound as a canonical conversion. Signature composition must use these exact outputs rather than reconstructing an equal host value. |
| `TransactionSignaturePolicyFixedPrefix` | Checks contract width, validates `A` and `R`, applies cofactor policy, decomposes `S`, builds the variable-base table, and processes fixed-base windows 0–36 | 891 + 5 = 896 | 9 inputs; 161 outputs | Composition-dependent. Solidity must bind `S < n`, selector width, and the identity point; later signature placements must consume its exact bits, table, accumulators, and `R8`. |
| `TransactionSignatureFixedVariableBridge` | Processes fixed-base windows 37–74 and variable-base windows 127–111 | 911 + 0 = 911 | 159 inputs; 8 extended-coordinate outputs | Composition-dependent. It consumes exact prefix outputs and the high 33 challenge bits from the canonical challenge view. |
| `TransactionSignatureVariableBatch` | Processes 34 two-bit variable-base windows while retaining the extended accumulator | 1,020 + 0 = 1,020 | 80 inputs; 4 extended-coordinate outputs | Composition-dependent. Exactly three serial placements consume disjoint descending challenge-bit ranges and the same exact runtime-table wires. |
| `TransactionSignatureFinal` | Finishes both scalar multiplications, enforces the cofactored signature equation, and returns the 160-bit origin | 380 + 2 = 382 | 225 inputs; 2 origin limbs | Composition-dependent. It must receive both exact accumulator chains, `R8`, and bits 0–159 of the canonical public-key-hash view. |
| `EqualBatch` | Enforces two pairs of 256-bit words to be equal | 8 + 0 = 8 | 8 inputs: two left words followed by two right words; no outputs | Locally sound as limb equality. Storage consistency additionally depends on the composition layer routing the current and cached address/key values to the corresponding positions. |

## Mandatory and conditional composition contracts

### Division family: `ALU4A -> ALU4B`

Every `DIV`, `MOD`, `SDIV`, and `SMOD` operation uses exactly two adjacent
placements in this order. `ALU4A` consumes the operation selector and original
operands. Its 13 physical outputs must be connected to the 13 `ALU4B` inputs
without substitution or reordering:

1. `absDividend[2]`
2. `absQuotient[2]`
3. `absRemainder[2]`
4. `absDivisorWords[4]`
5. `divisorIsZero`
6. `resultIsNegative`
7. `useMod`

Only the two-limb output of `ALU4B` is the EVM result. Neither half represents
a sound or independently usable EVM division operation.

### Modular family: `CheckBus256 -> ADDMOD | MULMOD`

Every `ADDMOD` and `MULMOD` placement must be immediately preceded by one
`CheckBus256` placement. The two check inputs and the modular circuit's first
operand must be the exact same source wires in the final permutation. The
modular wrapper checks its second operand and modulus locally.

This is a mandatory topology contract, but it is not a declaration that the
current modular circuits are sound. The current full-width numerator and
reduction relations are tracked as incomplete and require separate local
remediation.

### EVM exponentiation: `DecToBit -> SubExpBatch*`

EVM `EXP(base, exponent)` uses one `DecToBit` placement on the exponent,
followed by `ceil(256 / nSubExpBatch())` serial `SubExpBatch` placements. With
the current `nSubExpBatch() = 8`, the chain has 32 batches. The first batch
receives accumulator `1`, base-power `base`, and exponent bits 0 through 7.
Each later batch consumes the exact accumulator and base-power outputs of its
predecessor and the next LSB-first bit group. Only the final accumulator is the
EVM result; the final base-power output is discarded.

This topology defines the intended operation but does not close the current
`SubExpBatch` local soundness gap.

### Poseidon chain expansion

One `Poseidon` placement supports up to `nPoseidonBatch()` consecutive
two-input compressions. The current batch size is 1, so the local selector is
`1` and each placement performs exactly one compression. For a longer input
list, the composition layer repeats this normalized placement and connects each
previous hash output as the first input of the next placement. This repetition
is structurally determined by the input count, not by witness values.

The repeated topology is required for the higher-arity hash operation. Unique
split-field encoding remains a separate producer or public-boundary contract.

### Transaction-signature composition

Transaction signature verification is one operation implemented by seven
compiled subcircuit types and 32 placements. The types are not independent
signature schemes. Their exact ordered composition is the security boundary:

1. Eight chain-mode `TransactionSignaturePoseidonBatch4` placements compute
   challenge hashes 0–31. One independent-mode placement computes the public-key
   hash and challenge hashes 32–34. This accounts for all 35 challenge
   compressions and the one public-key compression without using the general
   split-limb EVM `Poseidon` circuit.
2. Fourteen `FrToLimbsPair` placements convert 28 signed private transaction
   inputs into exact lower-first EVM limb pairs. One
   `TransactionSignatureCanonicalFrView` converts the remaining private input;
   two more canonical views decompose the final challenge and public-key hash.
   The EVM path must consume the 29 conversion outputs; it must not consume
   independently reconstructed limbs from the input buffer.
3. One `TransactionSignaturePolicyFixedPrefix` placement owns point validity,
   public-key subgroup policy, randomizer identity rejection, the 160-bit
   contract check, response-scalar decomposition, fixed windows 0–36, the
   runtime variable-base table, and `R8`.
4. One `TransactionSignatureFixedVariableBridge` placement consumes response
   bits 111–224 and challenge bits 222–254. It emits the fixed accumulator after
   window 74 and the variable accumulator after the first 17 MSB-first windows.
5. Three serial `TransactionSignatureVariableBatch` placements consume
   challenge-bit ranges 154–221, 86–153, and 18–85, respectively. Every
   placement receives the same eight runtime-table wires and the exact previous
   four-wire accumulator.
6. One `TransactionSignatureFinal` placement consumes response bits 225–251,
   challenge bits 0–17, both final accumulator chains, the exact four-wire
   `R8`, and public-key-hash bits 0–159. It enforces the cofactored equation and
   exposes the lower-first two-limb origin result.

For 29 private transaction inputs, the seven distinct types contain 5,697 O2
constraints and 6,171 R1CS wires in total. The 32 placements contain 29,677
constraints before final cross-placement permutation, and the live internal
boundary has 634 wire incidences. A diagnostic direct composition compiles to
29,615 nonlinear plus 3 linear constraints, exactly matching the monolithic
reference after O2.

The circuit owns contract width, point validity, public-key cofactor policy,
randomizer identity rejection, canonical transaction-input and challenge
views, scalar arithmetic, the cofactored terminal equation, and origin
derivation. The Solidity verifier must bind the exact public wires and enforce
`S < n`, `selector < 2^32`, and `O = (0, 1)`. These delegated checks are part of
the complete statement and cannot be omitted. All native field operands and
all intermediate accumulator coordinates remain private internal wires.

### Accumulator producer restriction

`Accumulator` is intended only for combining memory slices that were already
shifted and masked by sound arithmetic placements. The composition layer must route
only those canonical outputs into all 32 input-word positions and must not
permit a direct unchecked producer. The intended use also assumes that the
integer sum does not overflow 256 bits. These producer and overflow contracts
must be enforced before treating the current accumulator relation as sound.

### Public boundary contract

The final verifier wrapper validates the format of every public buffer input
and output. Non-buffer inputs and outputs are private internal wires connected
by the final permutation. If a future composition exposes a split 255-bit
Poseidon or Jubjub value publicly, the boundary must reject non-canonical field
encodings; checking each limb as merely 128-bit is not sufficient.

## Update checklist

When a subcircuit, capacity constant, or composition changes:

1. Update the production target list and every consumer-side target registry together.
2. Recompile every production target and update constraint and wire counts in
   this document.
3. Re-evaluate local soundness and every mandatory producer/consumer contract.
4. Update consumer-side composition definitions and exact-wire permutation tests.
5. Re-evaluate public/private boundaries in `scripts/configure.js` and
   `scripts/parse.js`.
6. Regenerate published circuit artifacts and any setup material only after
   the topology and soundness review is approved.
