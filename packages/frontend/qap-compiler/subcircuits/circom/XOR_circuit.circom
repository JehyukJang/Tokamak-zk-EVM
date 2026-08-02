pragma circom 2.1.6;
include "../../templates/256bit/evm_arithmetic.circom";

template XOR_() {
    signal input in[4];
    signal output out[2];

    component operation = EVMBitwise(2);
    operation.lhs <== [in[0], in[1]];
    operation.rhs <== [in[2], in[3]];
    out <== operation.out;
}

component main {public [in]} = XOR_();
