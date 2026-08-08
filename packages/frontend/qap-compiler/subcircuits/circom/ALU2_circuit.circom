pragma circom 2.1.6;
include "../../templates/256bit/alu_safe.circom";

template ALU2_() {
    var BASE_SELECTOR = 1 << 16;

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

    signal lowerLess <== LessThan(128)([in1[0], in2[0]]);
    signal upperLess <== LessThan(128)([in1[1], in2[1]]);
    signal upperEqual <== IsEqual()([in1[1], in2[1]]);
    signal lowerEqual <== IsEqual()([in1[0], in2[0]]);
    signal equal <== upperEqual * lowerEqual;
    signal unsignedLess <== upperLess + upperEqual * lowerLess;
    signal unsignedGreater <== 1 - unsignedLess - equal;

    signal signDiff <== isNeg1 + isNeg2 - 2 * isNeg1 * isNeg2;
    signal signedLess <== unsignedLess + signDiff * (isNeg1 - unsignedLess);
    signal signedGreater <== 1 - signedLess - equal;
    signal in1Zero <== IsZero256()(in1);

    // t is 0, 1, 3, 7, 15, or 31 for LT, GT, SLT, SGT, EQ, or ISZERO.
    signal t <== in[0] / BASE_SELECTOR - 1;
    signal basis2 <== t * (t - 1);
    signal basis3 <== basis2 * (t - 3);
    signal basis4 <== basis3 * (t - 7);
    signal basis5 <== basis4 * (t - 15);
    basis5 * (t - 31) === 0;

    // Newton interpolation selects exactly one of the six constrained results.
    signal coefficient1 <== -unsignedLess + unsignedGreater;
    signal coefficient2
        <== unsignedLess / 3 - unsignedGreater / 2 + signedLess / 6;
    signal coefficient3
        <== -unsignedLess / 21 + unsignedGreater / 12
        - signedLess / 24 + signedGreater / 168;
    signal coefficient4
        <== unsignedLess / 315 - unsignedGreater / 168
        + signedLess / 288 - signedGreater / 1344 + equal / 20160;
    signal coefficient5
        <== -unsignedLess / 9765 + unsignedGreater / 5040
        - signedLess / 8064 + signedGreater / 32256
        - equal / 322560 + in1Zero / 9999360;
    signal term1 <== t * coefficient1;
    signal term2 <== basis2 * coefficient2;
    signal term3 <== basis3 * coefficient3;
    signal term4 <== basis4 * coefficient4;
    signal term5 <== basis5 * coefficient5;

    out <== [unsignedLess + term1 + term2 + term3 + term4 + term5, 0];
}

component main {public [in]} = ALU2_();
