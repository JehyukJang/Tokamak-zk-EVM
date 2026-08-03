pragma circom 2.1.6;
include "../../templates/256bit/alu_safe.circom";

template ALU12_() {
    signal input in[5];
    signal output out[2];
    signal shift[2] <== [in[1], in[2]];
    signal value[2] <== [in[3], in[4]];

    signal useSar <== (in[0] - (1 << 28)) / ((1 << 29) - (1 << 28));
    useSar * (1 - useSar) === 0;
    shift[1] === 0;
    CheckBus128()(shift[0]);
    CheckBus256()(value);

    signal inverseShift <== 256 - shift[0];
    signal (expShift[2], isShiftGt255, expInverseShift[2], isInverseShiftGt255) <== FindShiftingTwosPower256TwoInput(8, 8)(shift[0], inverseShift);

    component right = Div256_unsafe();
    right.in1 <== value;
    right.in2 <== expShift;
    signal safeDivisor[2] <== _SafeDivisor()(expShift);

    signal (isNegative, absoluteValue[2]) <== getSignAndAbs256_unsafe()(value);
    component signedRight = _SignedShiftRight256_internal();
    signedRight.shift <== shift[0];
    signedRight.shifted_in <== right.q;
    signedRight.isNeg_in <== isNegative;
    signedRight.exp_inv_shift <== expInverseShift;
    signedRight.is_inv_shift_gt_255 <== isInverseShiftGt255;

    out[0] <== right.q[0] + useSar * (signedRight.out[0] - right.q[0]);
    out[1] <== right.q[1] + useSar * (signedRight.out[1] - right.q[1]);

    signal rangeCheck <== LessThan256()(right.r, safeDivisor);
    rangeCheck === 1;
}

component main {public [in]} = ALU12_();
