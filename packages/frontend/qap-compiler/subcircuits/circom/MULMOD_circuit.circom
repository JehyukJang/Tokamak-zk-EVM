pragma circom 2.1.6;
include "../../templates/256bit/evm_word_operations.circom";

template MULMOD_() {
    signal input in[6];
    signal output out[2];

    component operation = EVMMulMod();
    operation.lhs <== [in[0], in[1]];
    operation.rhs <== [in[2], in[3]];
    operation.modulus <== [in[4], in[5]];
    out <== operation.out;
}

component main {public [in]} = MULMOD_();
