pragma circom 2.1.6;

include "poseidon-bls12381-circom/circuits/poseidon255.circom";

// Test-only physical candidate for the selected transaction-signature
// three-Poseidon batch. Mode 1 computes one three-hash chain. Mode 0 computes
// one independent hash and one two-hash chain. The final composition owns the
// structural mode assigned to each placement.
template TransactionSignaturePoseidonBatch3Candidate() {
    signal input in[6];
    signal output out[2];

    signal mode <== in[0];
    mode * (mode - 1) === 0;

    component firstHash = Poseidon255(2);
    firstHash.in <== [in[1], in[2]];

    signal secondLeft <== in[3] + mode * (firstHash.out - in[3]);
    component secondHash = Poseidon255(2);
    secondHash.in <== [secondLeft, in[4]];

    component thirdHash = Poseidon255(2);
    thirdHash.in <== [secondHash.out, in[5]];

    out <== [firstHash.out, thirdHash.out];
}
