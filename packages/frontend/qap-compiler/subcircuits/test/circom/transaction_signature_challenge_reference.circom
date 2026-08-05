pragma circom 2.1.6;

include "poseidon-bls12381-circom/circuits/poseidon255.circom";
include "circomlib/circuits/bitify.circom";

// BLS12-381 Fr is split at the 128-bit limb boundary. This helper assumes
// that low is already constrained to 128 bits and high to 127 bits. It proves
// low + 2^128 * high <= Fr - 1 through a bounded two-limb subtraction.
template StrictBls12381FieldBoundFromLimbs_unsafe() {
    signal input low;
    signal input high;

    var LIMB_BASE = 1 << 128;
    var FIELD_MAX_LOW = 111310594309268602877181240610339684352;
    var FIELD_MAX_HIGH = 154095187621958656428822154526901524485;

    signal lowBorrow <-- low > FIELD_MAX_LOW;
    lowBorrow * (1 - lowBorrow) === 0;

    component lowDifference = Num2Bits(128);
    lowDifference.in <== FIELD_MAX_LOW - low + lowBorrow * LIMB_BASE;

    component highDifference = Num2Bits(127);
    highDifference.in <== FIELD_MAX_HIGH - high - lowBorrow;
}

// Proves that one split private word has exactly one integer representative in
// [0, Fr - 1]. The returned field value is the only value that may enter the
// Poseidon challenge chain.
template CanonicalPrivateFieldWord() {
    signal input in[2];
    signal output value;

    component lowBits = Num2Bits(128);
    lowBits.in <== in[0];

    component highBits = Num2Bits(127);
    highBits.in <== in[1];

    component fieldBound = StrictBls12381FieldBoundFromLimbs_unsafe();
    fieldBound.low <== in[0];
    fieldBound.high <== in[1];

    value <== in[0] + in[1] * (1 << 128);
}

// Produces the unique canonical 255-bit integer representation of a native Fr
// element. Num2Bits alone is insufficient because both x and x + Fr may fit in
// 255 bits while representing the same circuit-field element.
template CanonicalBls12381FieldBits() {
    signal input in;
    signal output bits[255];

    component decomposition = Num2Bits(255);
    decomposition.in <== in;

    var lowExpression = 0;
    var highExpression = 0;
    for (var i = 0; i < 128; i++) {
        bits[i] <== decomposition.out[i];
        lowExpression += decomposition.out[i] * (1 << i);
    }
    for (var i = 128; i < 255; i++) {
        bits[i] <== decomposition.out[i];
        highExpression += decomposition.out[i] * (1 << (i - 128));
    }

    signal low <== lowExpression;
    signal high <== highExpression;

    component fieldBound = StrictBls12381FieldBoundFromLimbs_unsafe();
    fieldBound.low <== low;
    fieldBound.high <== high;
}

// This is the first executable stage of the non-production monolithic
// TransactionSignatureVerify reference. Its inputs are exactly the N + 7 word
// prefix of the final N + 12 operand interface:
//
// R.x, R.y, A.x, A.y, nonce, contract, selector, input[0..N-1].
//
// The final reference circuit will consume the remaining S, G, and O operands
// and expose only origin. This stage exposes the challenge solely so its fixed
// schedule and canonical decomposition can be tested before those relations
// are implemented.
template TransactionSignatureChallengeReference(N) {
    assert(N > 0);

    signal input in[N + 7][2];
    signal output challenge[2];
    signal output challengeBits[255];

    var LIMB_BASE = 1 << 128;

    signal challengeInputs[N + 7];
    for (var i = 0; i < 4; i++) {
        challengeInputs[i] <== in[i][0] + in[i][1] * LIMB_BASE;
    }

    component privateWords[N + 1];
    privateWords[0] = CanonicalPrivateFieldWord();
    privateWords[0].in <== in[4];
    challengeInputs[4] <== privateWords[0].value;

    challengeInputs[5] <== in[5][0] + in[5][1] * LIMB_BASE;
    challengeInputs[6] <== in[6][0] + in[6][1] * LIMB_BASE;

    for (var i = 0; i < N; i++) {
        privateWords[i + 1] = CanonicalPrivateFieldWord();
        privateWords[i + 1].in <== in[i + 7];
        challengeInputs[i + 7] <== privateWords[i + 1].value;
    }

    component hashes[N + 6];
    hashes[0] = Poseidon255(2);
    hashes[0].in[0] <== challengeInputs[0];
    hashes[0].in[1] <== challengeInputs[1];

    for (var i = 1; i < N + 6; i++) {
        hashes[i] = Poseidon255(2);
        hashes[i].in[0] <== hashes[i - 1].out;
        hashes[i].in[1] <== challengeInputs[i + 1];
    }

    component canonicalChallenge = CanonicalBls12381FieldBits();
    canonicalChallenge.in <== hashes[N + 5].out;
    challengeBits <== canonicalChallenge.bits;

    var challengeLow = 0;
    var challengeHigh = 0;
    for (var i = 0; i < 128; i++) {
        challengeLow += canonicalChallenge.bits[i] * (1 << i);
    }
    for (var i = 128; i < 255; i++) {
        challengeHigh += canonicalChallenge.bits[i] * (1 << (i - 128));
    }
    challenge[0] <== challengeLow;
    challenge[1] <== challengeHigh;
}
