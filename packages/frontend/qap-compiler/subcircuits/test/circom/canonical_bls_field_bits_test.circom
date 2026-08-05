pragma circom 2.1.6;

include "./transaction_signature_challenge_reference.circom";

template CanonicalBls12381FieldBitsTest() {
    signal input fieldValue;
    signal input claimedBits[255];

    component canonical = CanonicalBls12381FieldBits();
    canonical.in <== fieldValue;
    for (var i = 0; i < 255; i++) {
        canonical.bits[i] === claimedBits[i];
    }
}

component main = CanonicalBls12381FieldBitsTest();
