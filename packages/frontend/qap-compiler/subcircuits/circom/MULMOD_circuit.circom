pragma circom 2.1.6;
include "../../templates/256bit/alu_safe.circom";

template MULMOD_() {
    signal input in[6];
    signal output out[2];

    signal in1[2] <== [in[0], in[1]];
    signal in2[2] <== [in[2], in[3]];
    signal in3[2] <== [in[4], in[5]];

    out <== MulMod256()(in1, in2, in3);
}

component main {public [in]} = MULMOD_();
