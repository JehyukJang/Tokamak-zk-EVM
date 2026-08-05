pragma circom 2.1.6;

include "./transaction_signature_verify_reference.circom";

// Compares the two bounded limbs directly against Fr - 1. The high limb owns
// the primary ordering; the low limb matters only when the high limbs match.
template CanonicalPrivateFieldWordLexicographic() {
    signal input in[2];
    signal output value;

    var FIELD_MAX_LOW = 111310594309268602877181240610339684352;
    var FIELD_MAX_HIGH = 154095187621958656428822154526901524485;

    component lowBits = Num2Bits(128);
    lowBits.in <== in[0];

    component highBits = Num2Bits(127);
    highBits.in <== in[1];

    component highLess = LessThan(127);
    highLess.in[0] <== in[1];
    highLess.in[1] <== FIELD_MAX_HIGH;

    component highEqual = IsEqual();
    highEqual.in[0] <== in[1];
    highEqual.in[1] <== FIELD_MAX_HIGH;

    component lowAtMost = LessEqThan(128);
    lowAtMost.in[0] <== in[0];
    lowAtMost.in[1] <== FIELD_MAX_LOW;

    highLess.out + highEqual.out * lowAtMost.out === 1;
    value <== in[0] + in[1] * (1 << 128);
}

// Adds 2^255 - Fr in two bounded limbs. The final 127-bit sum exists exactly
// when the original value is below Fr; Fr itself would carry into bit 255.
template CanonicalPrivateFieldWordComplementCarry() {
    signal input in[2];
    signal output value;

    var LIMB_BASE = 1 << 128;
    var COMPLEMENT_LOW = 228971772611669860586193366821428527103;
    var COMPLEMENT_HIGH = 16045995838510575302865149188982581242;

    component lowBits = Num2Bits(128);
    lowBits.in <== in[0];

    component highBits = Num2Bits(127);
    highBits.in <== in[1];

    signal lowCarry <-- in[0] + COMPLEMENT_LOW >= LIMB_BASE;
    lowCarry * (1 - lowCarry) === 0;

    component lowSum = Num2Bits(128);
    lowSum.in <== in[0] + COMPLEMENT_LOW - lowCarry * LIMB_BASE;

    component highSum = Num2Bits(127);
    highSum.in <== in[1] + COMPLEMENT_HIGH + lowCarry;

    value <== in[0] + in[1] * LIMB_BASE;
}

template CanonicalPrivateFieldWordBaselineTest() {
    signal input in[2];
    signal output value;

    component candidate = CanonicalPrivateFieldWord();
    candidate.in <== in;
    value <== candidate.value;
}

template CanonicalPrivateFieldWordLexicographicTest() {
    signal input in[2];
    signal output value;

    component candidate = CanonicalPrivateFieldWordLexicographic();
    candidate.in <== in;
    value <== candidate.value;
}

template CanonicalPrivateFieldWordComplementCarryTest() {
    signal input in[2];
    signal output value;

    component candidate = CanonicalPrivateFieldWordComplementCarry();
    candidate.in <== in;
    value <== candidate.value;
}
