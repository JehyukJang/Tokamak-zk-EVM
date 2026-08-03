pragma circom 2.1.6;
include "../../templates/256bit/alu_safe.circom";

template ALU8_() {
    signal input in[5];
    signal output out[2];
    signal in1[2] <== [in[1], in[2]];
    signal in2[2] <== [in[3], in[4]];

    CheckBus256()(in1);
    CheckBus256()(in2);

    signal useMod <== (in[0] - (1 << 5)) / ((1 << 7) - (1 << 5));
    useMod * (1 - useMod) === 0;

    signal (isNeg1, abs1[2]) <== getSignAndAbs256_unsafe()(in1);
    signal (isNeg2, abs2[2]) <== getSignAndAbs256_unsafe()(in2);
    signal (absQ[2], absR[2]) <== Div256_unsafe()(abs1, abs2);
    signal isNegQ <== XOR()(isNeg1, isNeg2);
    signal q[2] <== recoverSignedInteger256_unsafe()(isNegQ, absQ);
    signal r[2] <== recoverSignedInteger256_unsafe()(isNeg1, absR);
    signal safeDivisor[2] <== _SafeDivisor()(abs2);
    signal rangeCheck <== LessThan256()(absR, safeDivisor);
    rangeCheck === 1;

    out <== Mux256()(useMod, r, q);
}

component main {public [in]} = ALU8_();
