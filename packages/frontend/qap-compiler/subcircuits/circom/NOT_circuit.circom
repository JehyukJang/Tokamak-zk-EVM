pragma circom 2.1.6;
include "../../templates/256bit/evm_arithmetic.circom";

template NOT_() {
    signal input in[2];
    signal output out[2];

    component operation = EVMNot();
    operation.in <== in;
    out <== operation.out;
}

component main {public [in]} = NOT_();
