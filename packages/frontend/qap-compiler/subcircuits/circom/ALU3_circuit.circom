pragma circom 2.1.6;
include "../../templates/256bit/alu_safe.circom";

template ALU3_() {
    signal input in[5];
    signal output out[2];
    signal in1[2] <== [in[1], in[2]];
    signal in2[2] <== [in[3], in[4]];

    CheckBus256()(in1);
    CheckBus256()(in2);

    signal useGt <== (in[0] - (1 << 18)) / ((1 << 19) - (1 << 18));
    useGt * (1 - useGt) === 0;

    signal (isNeg1, abs1[2]) <== getSignAndAbs256_unsafe()(in1);
    signal (isNeg2, abs2[2]) <== getSignAndAbs256_unsafe()(in2);
    signal absLtLower <== LessThan(128)([abs1[0], abs2[0]]);
    signal absLtUpper <== LessThan(128)([abs1[1], abs2[1]]);
    signal absUpperEq <== IsEqual()([abs1[1], abs2[1]]);
    signal absLowerEq <== IsEqual()([abs1[0], abs2[0]]);
    signal absEqual <== absUpperEq * absLowerEq;
    signal absUpperLess <== (1 - absUpperEq) * absLtUpper;
    signal absLowerLess <== absUpperEq * absLtLower;
    signal absLess <== absUpperLess + absLowerLess;
    signal absGreater <== (1 - absLess) * (1 - absEqual);
    signal signDiff <== XOR()(isNeg1, isNeg2);
    signal positiveLess <== absLess * (1 - isNeg1);
    signal negativeLess <== absGreater * isNeg1;
    signal sameSignLess <== OR()(positiveLess, negativeLess);
    signal less <== sameSignLess + signDiff * (isNeg1 - sameSignLess);

    signal rawUpperEq <== IsEqual()([in1[1], in2[1]]);
    signal rawLowerEq <== IsEqual()([in1[0], in2[0]]);
    signal rawEqual <== rawUpperEq * rawLowerEq;
    signal greater <== (1 - less) * (1 - rawEqual);

    out <== [less + useGt * (greater - less), 0];
}

component main {public [in]} = ALU3_();
