pragma circom 2.1.6;
include "../../templates/256bit/alu_safe.circom";

template ALU3_() {
    signal input in[5];
    signal output out[2];
    signal in1[2] <== [in[1], in[2]];
    signal in2[2] <== [in[3], in[4]];

    CheckBus128()(in1[0]);
    CheckBus128()(in2[0]);

    component in1HighBits = Num2Bits(128);
    component in2HighBits = Num2Bits(128);
    in1HighBits.in <== in1[1];
    in2HighBits.in <== in2[1];
    signal isNeg1 <== in1HighBits.out[127];
    signal isNeg2 <== in2HighBits.out[127];

    signal useGt <== (in[0] - (1 << 18)) / ((1 << 19) - (1 << 18));
    useGt * (1 - useGt) === 0;

    signal lowerLess <== LessThan(128)([in1[0], in2[0]]);
    signal upperLess <== LessThan(128)([in1[1], in2[1]]);
    signal upperEqual <== IsEqual()([in1[1], in2[1]]);
    signal lowerEqual <== IsEqual()([in1[0], in2[0]]);
    signal unsignedLess <== upperLess + upperEqual * lowerLess;
    signal equal <== upperEqual * lowerEqual;

    signal signDiff <== isNeg1 + isNeg2 - 2 * isNeg1 * isNeg2;
    signal less <== unsignedLess + signDiff * (isNeg1 - unsignedLess);
    signal greater <== 1 - less - equal;

    out <== [less + useGt * (greater - less), 0];
}

component main {public [in]} = ALU3_();
