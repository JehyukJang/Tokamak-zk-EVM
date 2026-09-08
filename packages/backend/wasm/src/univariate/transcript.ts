import { keccak256 } from "../runtime/crypto/keccak.js";
import type { FieldElement, FieldRuntime } from "../runtime/field/field-types.js";

const TEXT_ENCODER = new TextEncoder();
export const UNIVARIATE_FIAT_SHAMIR_SCHEMA_ID = "tokamak-zk-evm-univariate-fs-v3";
const TRANSCRIPT_DOMAIN = TEXT_ENCODER.encode(UNIVARIATE_FIAT_SHAMIR_SCHEMA_ID);

/** Builds the type-tagged, length-prefixed F2--F4 encoding. */
export class CanonicalTranscriptEncoder {
  private readonly chunks: Uint8Array[] = [];

  bytes(label: string, value: Uint8Array): this {
    const labelBytes = TEXT_ENCODER.encode(label);
    if (labelBytes.byteLength > 0xffffffff) {
      throw new Error("Transcript label exceeds u32 length.");
    }
    const labelHeader = new Uint8Array(4);
    new DataView(labelHeader.buffer).setUint32(0, labelBytes.byteLength, false);
    const valueHeader = new Uint8Array(8);
    new DataView(valueHeader.buffer).setBigUint64(0, BigInt(value.byteLength), false);
    this.chunks.push(labelHeader, labelBytes, valueHeader, value);
    return this;
  }

  u32(label: string, value: number): this {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error("Transcript u32 value is outside its range.");
    }
    const encoded = new Uint8Array(4);
    new DataView(encoded.buffer).setUint32(0, value, false);
    return this.bytes(label, encoded);
  }

  scalar(label: string, field: FieldRuntime, value: FieldElement): this {
    return this.bytes(label, bigEndianFieldBytes(field, value));
  }

  finish(): Uint8Array {
    const length = this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }
}

/** F4 Keccak-256 challenge state for the univariate protocol. */
export class UnivariateTranscript {
  private history = new Uint8Array();
  private readonly statement: Uint8Array;

  constructor(
    private readonly field: FieldRuntime,
    publicInputs: readonly FieldElement[],
  ) {
    this.statement = encodePublicInputs(field, publicInputs);
  }

  appendMessageBlock(block: number, encodedMessage: Uint8Array): void {
    this.append(
      new CanonicalTranscriptEncoder()
        .u32("message-block", block)
        .bytes("message", encodedMessage)
        .finish(),
    );
  }

  challenge(round: number, outputIndex: number): FieldElement {
    const value = this.sampleValue(round, outputIndex, () => true);
    this.recordChallenge(round, outputIndex, value);
    return value;
  }

  /** Samples F3's `(beta, gamma_C)` from the same F4 transcript state. */
  challengePair(round: number): readonly [FieldElement, FieldElement] {
    const first = this.sampleValue(round, 0, () => true);
    const second = this.sampleValue(round, 1, () => true);
    this.recordChallenge(round, 0, first);
    this.recordChallenge(round, 1, second);
    return [first, second];
  }

  zeta(arithmeticSize: number, connectionSize: number): FieldElement {
    const value = this.sampleValue(4, 0, (candidate) => (
      !this.field.eq(candidate, this.field.zero)
      && !this.field.eq(this.field.pow(candidate, arithmeticSize), this.field.one)
      && !this.field.eq(this.field.pow(candidate, connectionSize), this.field.one)
    ));
    this.recordChallenge(4, 0, value);
    return value;
  }

  nonzeroChallenge(round: number, outputIndex: number): FieldElement {
    const value = this.sampleValue(round, outputIndex, (candidate) => !this.field.eq(candidate, this.field.zero));
    this.recordChallenge(round, outputIndex, value);
    return value;
  }

  private sampleValue(round: number, outputIndex: number, accepts: (value: FieldElement) => boolean): FieldElement {
    for (let counter = 0; counter <= 0xffffffff; counter += 1) {
      const input = new CanonicalTranscriptEncoder()
        .bytes("protocol", TRANSCRIPT_DOMAIN)
        .u32("round", round)
        .u32("output-index", outputIndex)
        .bytes("statement", this.statement)
        .bytes("history", this.history)
        .u32("rejection-counter", counter)
        .finish();
      const candidate = bytesToBigInt(keccak256(input));
      if (candidate >= this.field.modulus) {
        continue;
      }
      const value = this.field.fromBigInt(candidate);
      if (!accepts(value)) {
        continue;
      }
      return value;
    }
    throw new Error("Fiat--Shamir rejection counter overflow.");
  }

  private recordChallenge(round: number, outputIndex: number, value: FieldElement): void {
    this.append(
      new CanonicalTranscriptEncoder()
        .u32("challenge-round", round)
        .u32("challenge-output-index", outputIndex)
        .scalar("challenge", this.field, value)
        .finish(),
    );
  }

  private append(value: Uint8Array): void {
    const next = new Uint8Array(this.history.byteLength + value.byteLength);
    next.set(this.history);
    next.set(value, this.history.byteLength);
    this.history = next;
  }
}

/** Encodes F1's adaptive public statement and no fixed verifier parameter. */
export function encodePublicInputs(field: FieldRuntime, publicInputs: readonly FieldElement[]): Uint8Array {
  let encoder = new CanonicalTranscriptEncoder().u32("public-input-count", publicInputs.length);
  for (let index = 0; index < publicInputs.length; index += 1) {
    encoder = encoder.scalar(`public-input.${index}`, field, publicInputs[index]!);
  }
  return encoder.finish();
}

function bigEndianFieldBytes(field: FieldRuntime, value: FieldElement): Uint8Array {
  const littleEndian = field.toRawLittleEndian(value);
  const output = littleEndian.slice();
  output.reverse();
  return output;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}
