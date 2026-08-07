pragma circom 2.1.6;

include "./transaction_signature_verify_reference.circom";
include "../../circom/constants.circom";

template TransactionSignatureVerifyReferenceBoundary(N) {
    signal input privateIn[N + 5];
    signal input contractAddress;
    signal input functionSelector;
    signal input S;
    signal input O[2];
    signal output evmContractAddress[2];
    signal output evmFunctionSelector[2];
    signal output evmTransactionInputs[N][2];
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
    evmContractAddress <== reference.evmContractAddress;
    evmFunctionSelector <== reference.evmFunctionSelector;
    evmTransactionInputs <== reference.evmTransactionInputs;
    origin <== reference.origin;
}

// This diagnostic main exposes every operation result so the revised physical
// interface can be inspected. These outputs do not define the public boundary
// of the later composed production circuit.
component main {public [contractAddress, functionSelector, S, O]} =
    TransactionSignatureVerifyReferenceBoundary(nPrivateMessageInputs());
