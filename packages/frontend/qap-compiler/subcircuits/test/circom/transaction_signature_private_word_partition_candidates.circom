pragma circom 2.1.6;

include "./transaction_signature_verify_reference.circom";

// Composition-only candidate that owns the two limb-width relations. It has
// no output because both physical fragments consume the exact same source
// limbs through the final permutation.
template TransactionSignaturePrivateWordLimbCheckCandidate() {
    signal input in[2];

    component lowBits = Num2Bits(128);
    lowBits.in <== in[0];

    component highBits = Num2Bits(127);
    highBits.in <== in[1];
}

// Composition-only candidate that owns the strict field bound and the one
// native-field merge consumed by the fixed challenge hash chain.
template TransactionSignaturePrivateWordBoundAndMergeCandidate() {
    signal input in[2];
    signal output value;

    component fieldBound = StrictBls12381FieldBoundFromLimbs_unsafe();
    fieldBound.low <== in[0];
    fieldBound.high <== in[1];

    value <== in[0] + in[1] * (1 << 128);
}

// Test-only direct composition. Security depends on both candidates receiving
// the same two source wires; neither fragment may reconstruct or copy them.
template TransactionSignaturePrivateWordPartitionCandidate() {
    signal input in[2];
    signal output value;

    component limbCheck = TransactionSignaturePrivateWordLimbCheckCandidate();
    limbCheck.in <== in;

    component boundAndMerge = TransactionSignaturePrivateWordBoundAndMergeCandidate();
    boundAndMerge.in <== in;
    value <== boundAndMerge.value;
}
