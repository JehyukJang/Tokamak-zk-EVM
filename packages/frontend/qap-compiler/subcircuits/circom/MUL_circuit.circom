pragma circom 2.1.6;
include "../../templates/256bit/evm_word_operations.circom";

template MUL_() {
    signal input in[4];
    signal output out[2];

    component operation = EVMMul();
    operation.lhs <== [in[0], in[1]];
    operation.rhs <== [in[2], in[3]];
    out <== operation.out;
}

component main {public [in]} = MUL_();
