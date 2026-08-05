pragma circom 2.1.6;

include "./transaction_signature_verify_reference.circom";
include "../../circom/constants.circom";

template TransactionSignatureVerifyReferenceBoundary(N) {
    signal input privateIn[N + 5][2];
    signal input contractAddress[2];
    signal input functionSelector[2];
    signal input S[2];
    signal input O[2][2];
    signal output origin[2];

    component reference = TransactionSignatureVerifyReference(N);
    for (var i = 0; i < 5; i++) {
        reference.in[i] <== privateIn[i];
    }
    reference.in[5] <== contractAddress;
    reference.in[6] <== functionSelector;
    for (var i = 0; i < N; i++) {
        reference.in[i + 7] <== privateIn[i + 5];
    }
    reference.S <== S;
    reference.O <== O;
    origin <== reference.origin;
}

component main {public [contractAddress, functionSelector, S, O]} =
    TransactionSignatureVerifyReferenceBoundary(nPrivateMessageInputs());
