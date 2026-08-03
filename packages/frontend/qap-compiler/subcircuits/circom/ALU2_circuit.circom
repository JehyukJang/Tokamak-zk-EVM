pragma circom 2.1.6;
include "../../templates/256bit/alu_safe.circom";

template ALU2_() {
    signal input in[5];
    signal output out[2];
    signal in1[2] <== [in[1], in[2]];
    signal in2[2] <== [in[3], in[4]];

    CheckBus256()(in1);
    CheckBus256()(in2);

    signal useGt <== (in[0] - (1 << 16)) / ((1 << 17) - (1 << 16));
    useGt * (1 - useGt) === 0;

    signal ltLower <== LessThan(128)([in1[0], in2[0]]);
    signal ltUpper <== LessThan(128)([in1[1], in2[1]]);
    signal upperEq <== IsEqual()([in1[1], in2[1]]);
    signal lowerEq <== IsEqual()([in1[0], in2[0]]);
    signal equal <== upperEq * lowerEq;
    signal upperLess <== (1 - upperEq) * ltUpper;
    signal lowerLess <== upperEq * ltLower;
    signal less <== upperLess + lowerLess;
    signal greater <== (1 - less) * (1 - equal);

    out <== [less + useGt * (greater - less), 0];
}

component main {public [in]} = ALU2_();
