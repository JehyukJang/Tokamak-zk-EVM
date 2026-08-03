pragma circom 2.1.6;
include "../../templates/256bit/alu_safe.circom";

template ALU4_() {
    signal input in[5];
    signal output out[2];
    signal in1[2] <== [in[1], in[2]];
    signal in2[2] <== [in[3], in[4]];

    signal useMod <== (in[0] - (1 << 4)) / ((1 << 6) - (1 << 4));
    useMod * (1 - useMod) === 0;

    component div = DivMod256();
    div.dividend <== in1;
    div.divisor <== in2;

    out <== Mux256()(useMod, div.remainder, div.quotient);
}

component main {public [in]} = ALU4_();
