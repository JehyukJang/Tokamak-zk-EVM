pragma circom 2.1.6;

include "arithmetic_unsafe_type1.circom";
include "arithmetic_unsafe_type2.circom";
include "compare_safe.circom";
include "two_complement_unsafe.circom";
include "mux.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/gates.circom";

template SafeDivisor256() {
    signal input raw[2];
    signal output safe[2];

    signal isZero <== IsZero256()(raw);
    safe <== Mux256()(isZero, [0, 1 << 128], raw);
}

template EVMAdd() {
    signal input lhs[2], rhs[2];
    signal output out[2];

    CheckBus()(lhs);
    CheckBus()(rhs);
    signal carry;
    (out, carry) <== Add256_unsafe()(lhs, rhs);
    CheckBus()(out);
}

template EVMMul() {
    signal input lhs[2], rhs[2];
    signal output out[2];

    CheckBus()(lhs);
    CheckBus()(rhs);
    signal carry[2];
    (out, carry) <== Mul256_unsafe()(lhs, rhs);
    CheckBus()(out);
}

template EVMSub() {
    signal input lhs[2], rhs[2];
    signal output out[2];

    CheckBus()(lhs);
    CheckBus()(rhs);
    out <== Sub256_unsafe()(lhs, rhs);
    CheckBus()(out);
}

template EVMDiv() {
    signal input dividend[2], divisor[2];
    signal output out[2];

    CheckBus()(dividend);
    CheckBus()(divisor);
    signal remainder[2];
    (out, remainder) <== Div256_unsafe()(dividend, divisor);
    signal safeDivisor[2] <== SafeDivisor256()(divisor);
    signal rangeCheck <== LessThan256()(remainder, safeDivisor);
    rangeCheck === 1;
}

template EVMMod() {
    signal input dividend[2], divisor[2];
    signal output out[2];

    CheckBus()(dividend);
    CheckBus()(divisor);
    signal quotient[2];
    (quotient, out) <== Div256_unsafe()(dividend, divisor);
    signal safeDivisor[2] <== SafeDivisor256()(divisor);
    signal rangeCheck <== LessThan256()(out, safeDivisor);
    rangeCheck === 1;
}

template EVMSignedDiv() {
    signal input dividend[2], divisor[2];
    signal output out[2];

    CheckBus()(dividend);
    CheckBus()(divisor);
    signal dividendNegative;
    signal absoluteDividend[2];
    signal divisorNegative;
    signal absoluteDivisor[2];
    (dividendNegative, absoluteDividend) <== getSignAndAbs256_unsafe()(dividend);
    (divisorNegative, absoluteDivisor) <== getSignAndAbs256_unsafe()(divisor);

    signal absoluteQuotient[2];
    signal absoluteRemainder[2];
    (absoluteQuotient, absoluteRemainder) <== Div256_unsafe()(absoluteDividend, absoluteDivisor);
    signal quotientNegative <== XOR()(dividendNegative, divisorNegative);
    out <== recoverSignedInteger256_unsafe()(quotientNegative, absoluteQuotient);

    signal safeDivisor[2] <== SafeDivisor256()(absoluteDivisor);
    signal rangeCheck <== LessThan256()(absoluteRemainder, safeDivisor);
    rangeCheck === 1;
}

template EVMSignedMod() {
    signal input dividend[2], divisor[2];
    signal output out[2];

    CheckBus()(dividend);
    CheckBus()(divisor);
    signal dividendNegative;
    signal absoluteDividend[2];
    signal divisorNegative;
    signal absoluteDivisor[2];
    (dividendNegative, absoluteDividend) <== getSignAndAbs256_unsafe()(dividend);
    (divisorNegative, absoluteDivisor) <== getSignAndAbs256_unsafe()(divisor);

    signal absoluteQuotient[2];
    signal absoluteRemainder[2];
    (absoluteQuotient, absoluteRemainder) <== Div256_unsafe()(absoluteDividend, absoluteDivisor);
    out <== recoverSignedInteger256_unsafe()(dividendNegative, absoluteRemainder);

    signal safeDivisor[2] <== SafeDivisor256()(absoluteDivisor);
    signal rangeCheck <== LessThan256()(absoluteRemainder, safeDivisor);
    rangeCheck === 1;
}

template EVMAddMod() {
    signal input lhs[2], rhs[2], modulus[2];
    signal output out[2];

    // lhs is checked by a mandatory composed CheckBus placement.
    CheckBus()(rhs);
    CheckBus()(modulus);
    out <== AddMod256_unsafe()(lhs, rhs, modulus);
    signal safeModulus[2] <== SafeDivisor256()(modulus);
    signal rangeCheck <== LessThan256()(out, safeModulus);
    rangeCheck === 1;
}

template EVMMulMod() {
    signal input lhs[2], rhs[2], modulus[2];
    signal output out[2];

    // lhs is checked by a mandatory composed CheckBus placement.
    CheckBus()(rhs);
    CheckBus()(modulus);
    out <== MulMod256_unsafe()(lhs, rhs, modulus);
    signal safeModulus[2] <== SafeDivisor256()(modulus);
    signal rangeCheck <== LessThan256()(out, safeModulus);
    rangeCheck === 1;
}

template EVMUnsignedCompare(IS_GREATER) {
    signal input lhs[2], rhs[2];
    signal output out[2];

    CheckBus()(lhs);
    CheckBus()(rhs);
    signal lowerLess <== LessThan(128)([lhs[0], rhs[0]]);
    signal upperLess <== LessThan(128)([lhs[1], rhs[1]]);
    signal lowerEqual <== IsEqual()([lhs[0], rhs[0]]);
    signal upperEqual <== IsEqual()([lhs[1], rhs[1]]);
    signal equal <== lowerEqual * upperEqual;
    signal upperDecidesLess <== (1 - upperEqual) * upperLess;
    signal lowerDecidesLess <== upperEqual * lowerLess;
    signal less <== upperDecidesLess + lowerDecidesLess;
    signal greater <== (1 - less) * (1 - equal);
    out <== [IS_GREATER * greater + (1 - IS_GREATER) * less, 0];
}

template EVMSignedCompare(IS_GREATER) {
    signal input lhs[2], rhs[2];
    signal output out[2];

    CheckBus()(lhs);
    CheckBus()(rhs);
    signal lhsNegative;
    signal absoluteLhs[2];
    signal rhsNegative;
    signal absoluteRhs[2];
    (lhsNegative, absoluteLhs) <== getSignAndAbs256_unsafe()(lhs);
    (rhsNegative, absoluteRhs) <== getSignAndAbs256_unsafe()(rhs);

    signal lowerLess <== LessThan(128)([absoluteLhs[0], absoluteRhs[0]]);
    signal upperLess <== LessThan(128)([absoluteLhs[1], absoluteRhs[1]]);
    signal lowerEqual <== IsEqual()([absoluteLhs[0], absoluteRhs[0]]);
    signal upperEqual <== IsEqual()([absoluteLhs[1], absoluteRhs[1]]);
    signal equal <== lowerEqual * upperEqual;
    signal upperDecidesLess <== (1 - upperEqual) * upperLess;
    signal lowerDecidesLess <== upperEqual * lowerLess;
    signal absoluteLess <== upperDecidesLess + lowerDecidesLess;
    signal absoluteGreater <== (1 - absoluteLess) * (1 - equal);
    signal signsDiffer <== XOR()(lhsNegative, rhsNegative);
    signal positiveLess <== absoluteLess * (1 - lhsNegative);
    signal negativeLess <== absoluteGreater * lhsNegative;
    signal sameSignLess <== OR()(positiveLess, negativeLess);
    signal sameSignResult <== (1 - signsDiffer) * sameSignLess;
    signal differentSignResult <== signsDiffer * lhsNegative;
    signal signedLess <== sameSignResult + differentSignResult;
    signal signedGreater <== (1 - signedLess) * (1 - equal);
    out <== [IS_GREATER * signedGreater + (1 - IS_GREATER) * signedLess, 0];
}

template EVMEqual() {
    signal input lhs[2], rhs[2];
    signal output out[2];

    CheckBus()(lhs);
    CheckBus()(rhs);
    out <== [IsEqual256()(lhs, rhs), 0];
}

template EVMIsZero() {
    signal input in[2];
    signal output out[2];

    CheckBus()(in);
    out <== [IsZero256()(in), 0];
}

template EVMBitwise(OPERATION) {
    signal input lhs[2], rhs[2];
    signal output out[2];

    component lhsBits[2];
    component rhsBits[2];
    component result[2];
    for (var limb = 0; limb < 2; limb++) {
        lhsBits[limb] = Num2Bits(128);
        rhsBits[limb] = Num2Bits(128);
        result[limb] = Bits2Num(128);
        lhsBits[limb].in <== lhs[limb];
        rhsBits[limb].in <== rhs[limb];
        for (var bit = 0; bit < 128; bit++) {
            if (OPERATION == 0) {
                result[limb].in[bit] <== AND()(lhsBits[limb].out[bit], rhsBits[limb].out[bit]);
            } else if (OPERATION == 1) {
                result[limb].in[bit] <== OR()(lhsBits[limb].out[bit], rhsBits[limb].out[bit]);
            } else {
                result[limb].in[bit] <== XOR()(lhsBits[limb].out[bit], rhsBits[limb].out[bit]);
            }
        }
        out[limb] <== result[limb].out;
    }
}

template EVMNot() {
    signal input in[2];
    signal output out[2];

    CheckBus()(in);
    out <== Not256_unsafe()(in);
    CheckBus()(out);
}

template EVMSignExtend() {
    signal input index[2], value[2];
    signal output out[2];

    CheckBus()(value);
    index[1] === 0;
    signal remainder[2];
    signal divisor[2];
    (out, remainder, divisor) <== SignExtend256_unsafe()(index[0], value);
    signal rangeCheck <== LessThan256()(remainder, divisor);
    rangeCheck === 1;
}

template EVMByte() {
    signal input index[2], value[2];
    signal output out[2];

    CheckBus()(value);
    index[1] === 0;
    signal result;
    signal remainder;
    signal divisor;
    (result, remainder, divisor) <== Byte256_unsafe()(index[0], value);
    out <== [result, 0];
}

template EVMShiftLeft() {
    signal input shift[2], value[2];
    signal output out[2];

    CheckBus()(value);
    shift[1] === 0;
    signal expShift[2];
    signal isShiftGreaterThan255;
    (expShift, isShiftGreaterThan255) <== FindShiftingTwosPower256(8)(shift[0]);
    signal carry[2];
    (out, carry) <== Mul256_unsafe()(value, expShift);
    signal rangeCheck <== LessEqThan(128)([out[0], (1 << 128) - 1]);
    rangeCheck === 1;
}

template EVMShiftRight() {
    signal input shift[2], value[2];
    signal output out[2];

    CheckBus()(value);
    shift[1] === 0;
    signal expShift[2];
    signal isShiftGreaterThan255;
    (expShift, isShiftGreaterThan255) <== FindShiftingTwosPower256(8)(shift[0]);
    signal remainder[2];
    (out, remainder) <== Div256_unsafe()(value, expShift);
    signal safeDivisor[2] <== SafeDivisor256()(expShift);
    signal rangeCheck <== LessThan256()(remainder, safeDivisor);
    rangeCheck === 1;
}

template EVMSignedShiftRight() {
    signal input shift[2], value[2];
    signal output out[2];

    component valueBits[2];
    for (var limb = 0; limb < 2; limb++) {
        valueBits[limb] = Num2Bits(128);
        valueBits[limb].in <== value[limb];
    }
    shift[1] === 0;
    signal inverseShift <== 256 - shift[0];
    signal expShift[2];
    signal isShiftGreaterThan255;
    signal expInverseShift[2];
    signal isInverseShiftGreaterThan255;
    (expShift, isShiftGreaterThan255, expInverseShift, isInverseShiftGreaterThan255) <== FindShiftingTwosPower256TwoInput(8, 8)(shift[0], inverseShift);

    signal shifted[2];
    signal remainder[2];
    (shifted, remainder) <== Div256_unsafe()(value, expShift);
    signal safeDivisor[2] <== SafeDivisor256()(expShift);
    signal rangeCheck <== LessThan256()(remainder, safeDivisor);
    rangeCheck === 1;

    signal isNegative <== valueBits[1].out[127];
    component signedShift = _SignedShiftRight256_internal();
    signedShift.shift <== shift[0];
    signedShift.shifted_in <== shifted;
    signedShift.isNeg_in <== isNegative;
    signedShift.exp_inv_shift <== expInverseShift;
    signedShift.is_inv_shift_gt_255 <== isInverseShiftGreaterThan255;
    out <== signedShift.out;
}
