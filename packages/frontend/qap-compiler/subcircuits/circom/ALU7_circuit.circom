pragma circom 2.1.6;
include "../../templates/256bit/alu_safe.circom";

template ALU7_() {
    signal input in[5];
    signal output out[2];
    signal in1[2] <== [in[1], in[2]];
    signal in2[2] <== [in[3], in[4]];

    CheckBus()(in1);
    CheckBus()(in2);

    signal useMod <== (in[0] - (1 << 4)) / ((1 << 6) - (1 << 4));
    useMod * (1 - useMod) === 0;

    component div = Div256_unsafe();
    div.in1 <== in1;
    div.in2 <== in2;
    signal safeDivisor[2] <== _SafeDivisor()(in2);
    signal rangeCheck <== LessThan256()(div.r, safeDivisor);
    rangeCheck === 1;

    out <== Mux256()(useMod, div.r, div.q);
}

component main {public [in]} = ALU7_();
