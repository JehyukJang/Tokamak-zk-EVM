pragma circom 2.1.6;

include "poseidon-bls12381-circom/circuits/poseidon255.circom";

// Test-only physical candidate for the selected transaction-signature
// four-Poseidon batch. Mode 1 computes one four-hash chain. Mode 0 computes
// one independent hash and one three-hash chain. The final composition owns
// the structural mode assigned to each placement.
template TransactionSignaturePoseidonBatch4Candidate() {
    signal input in[7];
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

    component fourthHash = Poseidon255(2);
    fourthHash.in <== [thirdHash.out, in[6]];

    out <== [firstHash.out, fourthHash.out];
}
