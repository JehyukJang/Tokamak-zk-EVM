pragma circom 2.1.6;

include "./transaction_signature_verify_reference.circom";

// Composition-only candidate that exposes a lower-first limb witness for one
// native field value. The three paired validation candidates must consume
// these exact output wires through the final permutation.
template TransactionSignatureNativeEvmWordMergeCandidate() {
    signal input in;
    signal output limbs[2];

    var LIMB_BASE = 1 << 128;
    limbs[0] <-- in % LIMB_BASE;
    limbs[1] <-- in \ LIMB_BASE;
    in === limbs[0] + limbs[1] * LIMB_BASE;
}

template TransactionSignatureNativeEvmWordLowCheckCandidate() {
    signal input limb;

    component bits = Num2Bits(128);
    bits.in <== limb;
}

template TransactionSignatureNativeEvmWordHighCheckCandidate() {
    signal input limb;

    component bits = Num2Bits(127);
    bits.in <== limb;
}

// Composition-only candidate that proves the exact limbs emitted by the
// merge candidate encode a value below BLS12-381 Fr. Limb widths are
// guaranteed by the paired low- and high-check candidates.
template TransactionSignatureNativeEvmWordFieldBoundCandidate() {
    signal input limbs[2];

    component fieldBound = StrictBls12381FieldBoundFromLimbs_unsafe();
    fieldBound.low <== limbs[0];
    fieldBound.high <== limbs[1];
}

// Test-only direct composition of the two prospective physical fragments.
template TransactionSignatureNativeEvmWordPartitionCandidate() {
    signal input in;
    signal output limbs[2];

    component merge = TransactionSignatureNativeEvmWordMergeCandidate();
    merge.in <== in;

    component lowCheck = TransactionSignatureNativeEvmWordLowCheckCandidate();
    lowCheck.limb <== merge.limbs[0];

    component highCheck = TransactionSignatureNativeEvmWordHighCheckCandidate();
    highCheck.limb <== merge.limbs[1];

    component fieldBound = TransactionSignatureNativeEvmWordFieldBoundCandidate();
    fieldBound.limbs <== merge.limbs;

    limbs <== merge.limbs;
}
