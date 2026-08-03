pragma circom 2.1.6;
include "../../templates/256bit/evm_word_operations.circom";

template ISZERO_() {
    signal input in[2];
    signal output out[2];

    component operation = EVMIsZero();
    operation.in <== in;
    out <== operation.out;
}

component main {public [in]} = ISZERO_();
