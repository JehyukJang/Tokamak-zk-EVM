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

    component inversePower = InverseShiftPower256FromBits_unsafe();
    inversePower.shiftBits <== right.shiftLowBits;

    var MAX_LIMB = (1 << 128) - 1;
    signal adjustedFiller[2];
    for (var limb = 0; limb < 2; limb++) {
        adjustedFiller[limb] <== inversePower.negativeFiller[limb]
            + (1 - right.inRange)
            * (MAX_LIMB - inversePower.negativeFiller[limb]);
    }

    signal applySignFill <== useSar * right.valueSign;
    out[0] <== right.out[0] + applySignFill * adjustedFiller[0];
    out[1] <== right.out[1] + applySignFill * adjustedFiller[1];
}

component main {public [in]} = ALU6_();
