pragma circom 2.1.6;
include "../../templates/256bit/evm_arithmetic.circom";

template LT_() {
    signal input in[4];
    signal output out[2];

    component operation = EVMUnsignedCompare(0);
    operation.lhs <== [in[0], in[1]];
    operation.rhs <== [in[2], in[3]];
    out <== operation.out;
}

component main {public [in]} = LT_();
