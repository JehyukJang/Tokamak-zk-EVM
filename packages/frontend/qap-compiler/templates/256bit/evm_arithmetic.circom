pragma circom 2.1.6;

include "arithmetic_unsafe_type1.circom";
include "arithmetic_sound.circom";
include "evm_word_sound.circom";
include "compare_safe.circom";
include "mux.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/gates.circom";

template DivMod256Sound() {
    signal input dividend[2], divisor[2];
    signal output quotient[2], remainder[2];

    CheckBus()(dividend);
    signal divisorIsZero <== IsZero256()(divisor);
    signal safeDivisor[2] <== Mux256()(divisorIsZero, [1, 0], divisor);

    var witnessValues[2][2] = _div256(dividend, safeDivisor);
    signal internalQuotient[2] <-- witnessValues[0];
    signal internalRemainder[2] <-- witnessValues[1];
    CheckBus()(internalRemainder);

    signal product[4] <== Mul256FullSound()(internalQuotient, safeDivisor);
    signal sumLow;
    signal carryLow;
    (sumLow, carryLow) <== Add128_unsafe()(product[0], internalRemainder[0]);
    sumLow === dividend[0];

    signal sumHighWithoutCarry;
    signal carryHigh0;
    (sumHighWithoutCarry, carryHigh0) <== Add128_unsafe()(product[1], internalRemainder[1]);
    signal sumHigh;
    signal carryHigh1;
    (sumHigh, carryHigh1) <== Add128_unsafe()(sumHighWithoutCarry, carryLow);
    sumHigh === dividend[1];
    product[2] + carryHigh0 + carryHigh1 === 0;
    product[3] === 0;

    signal remainderInRange <== LessThan256()(internalRemainder, safeDivisor);
    remainderInRange === 1;

    quotient[0] <== internalQuotient[0] * (1 - divisorIsZero);
    quotient[1] <== internalQuotient[1] * (1 - divisorIsZero);
    remainder[0] <== internalRemainder[0] * (1 - divisorIsZero);
    remainder[1] <== internalRemainder[1] * (1 - divisorIsZero);
}

template Reduce512By256Sound() {
    signal input numerator[4], modulus[2];
    signal output remainder[2];

    CheckBus()([numerator[0], numerator[1]]);
    CheckBus()([numerator[2], numerator[3]]);
    signal modulusIsZero <== IsZero256()(modulus);
    signal safeModulus[2] <== Mux256()(modulusIsZero, [1, 0], modulus);

    var witnessValues[2][4] = _div512by256(numerator, safeModulus);
    signal quotient[4] <-- witnessValues[0];
    signal internalRemainder[2] <-- [witnessValues[1][0], witnessValues[1][1]];
    CheckBus()(internalRemainder);

    signal product[6] <== Mul512By256FullSound()(quotient, safeModulus);
    signal sum[4];
    signal carry[4];
    (sum[0], carry[0]) <== Add128_unsafe()(product[0], internalRemainder[0]);
    signal limb1WithoutCarry;
    signal limb1Carry0;
    (limb1WithoutCarry, limb1Carry0) <== Add128_unsafe()(product[1], internalRemainder[1]);
    signal limb1Carry1;
    (sum[1], limb1Carry1) <== Add128_unsafe()(limb1WithoutCarry, carry[0]);
    carry[1] <== limb1Carry0 + limb1Carry1;
    (sum[2], carry[2]) <== Add128_unsafe()(product[2], carry[1]);
    (sum[3], carry[3]) <== Add128_unsafe()(product[3], carry[2]);
    for (var limb = 0; limb < 4; limb++) {
        sum[limb] === numerator[limb];
    }
    product[4] + carry[3] === 0;
    product[5] === 0;

    signal remainderInRange <== LessThan256()(internalRemainder, safeModulus);
    remainderInRange === 1;
    remainder[0] <== internalRemainder[0] * (1 - modulusIsZero);
    remainder[1] <== internalRemainder[1] * (1 - modulusIsZero);
}

template EVMAdd() {
    signal input lhs[2], rhs[2];
    signal output out[2];

    CheckBus()(lhs);
    CheckBus()(rhs);
    signal carry;
    (out, carry) <== Add256_unsafe()(lhs, rhs);
}

template EVMMul() {
    signal input lhs[2], rhs[2];
    signal output out[2];

    out <== Mul256TruncatedSound()(lhs, rhs);
}

template EVMSub() {
    signal input lhs[2], rhs[2];
    signal output out[2];

    CheckBus()(lhs);
    CheckBus()(rhs);
    out <== Sub256Sound()(lhs, rhs);
}

template EVMDiv() {
    signal input dividend[2], divisor[2];
    signal output out[2];

    signal remainder[2];
    (out, remainder) <== DivMod256Sound()(dividend, divisor);
}

template EVMMod() {
    signal input dividend[2], divisor[2];
    signal output out[2];

    signal quotient[2];
    (quotient, out) <== DivMod256Sound()(dividend, divisor);
}

template EVMSignedDiv() {
    signal input dividend[2], divisor[2];
    signal output out[2];

    signal dividendNegative;
    signal absoluteDividend[2];
    signal divisorNegative;
    signal absoluteDivisor[2];
    (dividendNegative, absoluteDividend) <== SignAndAbs256Sound()(dividend);
    (divisorNegative, absoluteDivisor) <== SignAndAbs256Sound()(divisor);

    signal absoluteQuotient[2];
    signal absoluteRemainder[2];
    (absoluteQuotient, absoluteRemainder) <== DivMod256Sound()(absoluteDividend, absoluteDivisor);
    signal quotientNegative <== XOR()(dividendNegative, divisorNegative);
    out <== RecoverSigned256Sound()(quotientNegative, absoluteQuotient);
}

template EVMSignedMod() {
    signal input dividend[2], divisor[2];
    signal output out[2];

    signal dividendNegative;
    signal absoluteDividend[2];
    signal divisorNegative;
    signal absoluteDivisor[2];
    (dividendNegative, absoluteDividend) <== SignAndAbs256Sound()(dividend);
    (divisorNegative, absoluteDivisor) <== SignAndAbs256Sound()(divisor);

    signal absoluteQuotient[2];
    signal absoluteRemainder[2];
    (absoluteQuotient, absoluteRemainder) <== DivMod256Sound()(absoluteDividend, absoluteDivisor);
    out <== RecoverSigned256Sound()(dividendNegative, absoluteRemainder);
}

template EVMAddMod() {
    signal input lhs[2], rhs[2], modulus[2];
    signal output out[2];

    // lhs is checked by a mandatory composed CheckBus placement.
    CheckBus()(rhs);
    signal sum[2];
    signal carry;
    (sum, carry) <== Add256_unsafe()(lhs, rhs);
    out <== Reduce512By256Sound()([sum[0], sum[1], carry, 0], modulus);
}

template EVMMulMod() {
    signal input lhs[2], rhs[2], modulus[2];
    signal output out[2];

    // lhs is checked by a mandatory composed CheckBus placement.
    signal product[4] <== Mul256FullSound()(lhs, rhs);
    out <== Reduce512By256Sound()(product, modulus);
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

    component lhsBits[2];
    component rhsBits[2];
    for (var limb = 0; limb < 2; limb++) {
        lhsBits[limb] = Num2Bits(128);
        rhsBits[limb] = Num2Bits(128);
        lhsBits[limb].in <== lhs[limb];
        rhsBits[limb].in <== rhs[limb];
    }
    signal lhsNegative <== lhsBits[1].out[127];
    signal rhsNegative <== rhsBits[1].out[127];

    signal lowerLess <== LessThan(128)([lhs[0], rhs[0]]);
    signal upperLess <== LessThan(128)([lhs[1], rhs[1]]);
    signal lowerEqual <== IsEqual()([lhs[0], rhs[0]]);
    signal upperEqual <== IsEqual()([lhs[1], rhs[1]]);
    signal equal <== lowerEqual * upperEqual;
    signal upperDecidesLess <== (1 - upperEqual) * upperLess;
    signal lowerDecidesLess <== upperEqual * lowerLess;
    signal unsignedLess <== upperDecidesLess + lowerDecidesLess;
    signal signsDiffer <== XOR()(lhsNegative, rhsNegative);
    signal sameSignResult <== (1 - signsDiffer) * unsignedLess;
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

    out <== FullDomainSignExtendSound()(index, value);
}

template EVMByte() {
    signal input index[2], value[2];
    signal output out[2];

    out <== FullDomainByteSound()(index, value);
}

template EVMShiftLeft() {
    signal input shift[2], value[2];
    signal output out[2];

    out <== FullDomainShiftSound(0, 0)(shift, value);
}

template EVMShiftRight() {
    signal input shift[2], value[2];
    signal output out[2];

    out <== FullDomainShiftSound(1, 0)(shift, value);
}

template EVMSignedShiftRight() {
    signal input shift[2], value[2];
    signal output out[2];

    out <== FullDomainShiftSound(1, 1)(shift, value);
}
