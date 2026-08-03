pragma circom 2.1.6;
include "../../templates/256bit/alu_safe.circom";

template ALU6_() {
    signal input in[5];
    signal output out[2];
    signal shift[2] <== [in[1], in[2]];
    signal value[2] <== [in[3], in[4]];

    signal useSar <== (in[0] - (1 << 28)) / ((1 << 29) - (1 << 28));
    useSar * (1 - useSar) === 0;

    component right = ShiftRight256();
    right.shift <== shift;
    right.value <== value;
    useSar * (1 - right.inRange) === 0;

    signal safeSarShift <== useSar * shift[0];
    signal inverseShift <== 256 - safeSarShift;
    signal (expInverseShift[2], isInverseShiftGt255) <== FindShiftingTwosPower256(9)(inverseShift);
    component signedRight = _SignedShiftRight256_internal();
    signedRight.shift <== safeSarShift;
    signedRight.shifted_in <== right.out;
    signedRight.isNeg_in <== right.valueSign;
    signedRight.exp_inv_shift <== expInverseShift;
    signedRight.is_inv_shift_gt_255 <== isInverseShiftGt255;

    out[0] <== right.out[0] + useSar * (signedRight.out[0] - right.out[0]);
    out[1] <== right.out[1] + useSar * (signedRight.out[1] - right.out[1]);
}

component main {public [in]} = ALU6_();
