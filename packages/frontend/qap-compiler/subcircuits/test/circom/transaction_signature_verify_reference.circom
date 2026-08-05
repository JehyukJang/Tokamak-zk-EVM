pragma circom 2.1.6;

include "./transaction_signature_fixed_base_extended_window.circom";

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

// For a validated point on this curve, y == 1 implies x == 0 because a != d.
// Therefore this single inverse relation rejects exactly the identity (0, 1).
template RejectJubjubIdentityFromValidatedY_unsafe() {
    signal input y;

    signal inverse <-- 1 / (y - 1);
    (y - 1) * inverse === 1;
}

// Both inputs must already be valid extended points with nonzero Z. Equality
// of X, Y, and Z up to one common scale proves equality of their affine points;
// T is then fixed by the extended-coordinate invariant.
template AssertExtendedJubjubEqual_unsafe() {
    signal input lhs[4];
    signal input rhs[4];

    signal scale <-- lhs[2] / rhs[2];
    for (var coordinate = 0; coordinate < 3; coordinate++) {
        lhs[coordinate] === scale * rhs[coordinate];
    }
}

// Multiplies an already-valid Jubjub point by the curve cofactor. Completeness
// of jubjubAdd guarantees that all three doublings have nonzero denominators.
template JubjubMulByCofactor8FromValidPoint_unsafe() {
    signal input point[2];
    signal output point8[2];

    signal point2[2] <== jubjubAdd()(point, point);
    signal point4[2] <== jubjubAdd()(point2, point2);
    point8 <== jubjubAdd()(point4, point4);
}

// The complete extended-coordinate formula is valid for this curve because
// a = -1 is a square and d = -(10240/10241) is a nonsquare in BLS12-381 Fr.
template TransactionSignaturePointValidationReference() {
    signal input A[2];
    signal input R[2];
    signal output A8[2];

    component checkA = jubjubCheck();
    checkA.in <== A;

    component checkR = jubjubCheck();
    checkR.in <== R;

    component publicKeyCofactor = AffineJubjubMulByCofactor8Extended_unsafe();
    publicKeyCofactor.point <== A;
    component affinePublicKeyCofactor = ExtendedJubjubToAffine_unsafe();
    affinePublicKeyCofactor.point <== publicKeyCofactor.point8;
    A8 <== affinePublicKeyCofactor.affine;

    component rejectA8Identity = RejectJubjubIdentityFromValidatedY_unsafe();
    rejectA8Identity.y <== A8[1];

    component rejectRIdentity = RejectJubjubIdentityFromValidatedY_unsafe();
    rejectRIdentity.y <== R[1];
}

// Computes the randomizer cofactor point used by the final verification
// equation. R is validated inside this reference circuit.
template TransactionSignatureRandomizerCofactorReference() {
    signal input R[2];
    signal output R8[4];

    component randomizerCofactor = AffineJubjubMulByCofactor8Extended_unsafe();
    randomizerCofactor.point <== R;
    R8 <== randomizerCofactor.point8;
}

// Binary LSB-first scalar multiplication for an already validated Jubjub base,
// an exact identity point, and bits constrained by one upstream decomposition.
// This core intentionally owns neither point validity nor bitness. It omits the
// final base doubling because no later scalar bit can consume that value.
template JubjubScalarMulFromConstrainedBits_unsafe(N) {
    assert(N > 0);

    signal input identity[2];
    signal input base[2];
    signal input bits[N];
    signal output result[2];

    signal accumulators[N + 1][2];
    signal powers[N][2];
    accumulators[0] <== identity;
    powers[0] <== base;

    component additions[N];
    component doublings[N - 1];
    for (var i = 0; i < N; i++) {
        additions[i] = jubjubAdd();
        additions[i].in1 <== accumulators[i];
        additions[i].in2 <== powers[i];

        for (var coordinate = 0; coordinate < 2; coordinate++) {
            accumulators[i + 1][coordinate] <== accumulators[i][coordinate]
                + bits[i] * (additions[i].out[coordinate] - accumulators[i][coordinate]);
        }

        if (i + 1 < N) {
            doublings[i] = jubjubAdd();
            doublings[i].in1 <== powers[i];
            doublings[i].in2 <== powers[i];
            powers[i + 1] <== doublings[i].out;
        }
    }

    result <== accumulators[N];
}

// Non-production monolithic TransactionSignatureVerify reference. Its private
// inputs begin with the N + 7 word challenge prefix:
//
// R.x, R.y, A.x, A.y, nonce, contract, selector, input[0..N-1].
//
// S and O are declared separately to preserve their public boundary while all
// N + 7 challenge inputs remain private. They are logical operands N + 7
// through N + 9 in the final ordered interface. Origin is the only result.
template TransactionSignatureVerifyReference(N) {
    assert(N > 0);

    signal input in[N + 7][2];
    signal input S[2];
    signal input O[2][2];
    signal output origin[2];

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

    component pointValidation = TransactionSignaturePointValidationReference();
    pointValidation.R <== [challengeInputs[0], challengeInputs[1]];
    pointValidation.A <== [challengeInputs[2], challengeInputs[3]];

    component randomizerCofactor = TransactionSignatureRandomizerCofactorReference();
    randomizerCofactor.R <== [challengeInputs[0], challengeInputs[1]];

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

    // Solidity owns the exact public-limb checks and S < n. This relation only
    // reconstructs those same public limbs into the 252 bits required by the
    // fixed-base scalar multiplication. It must not reduce S modulo n.
    component signatureDecomposition = Num2Bits(252);
    signatureDecomposition.in <== S[0] + S[1] * LIMB_BASE;

    signal nativeO[2];
    for (var coordinate = 0; coordinate < 2; coordinate++) {
        nativeO[coordinate] <== O[coordinate][0] + O[coordinate][1] * LIMB_BASE;
    }

    component responseScalar = FixedG8ExtendedWindowScalarMulFromConstrainedBits_unsafe(252, 3);
    responseScalar.bits <== signatureDecomposition.out;

    component challengeScalar = VariableBaseExtendedWindowScalarMulFromConstrainedBits_unsafe(255, 2);
    challengeScalar.identity <== nativeO;
    challengeScalar.base <== pointValidation.A8;
    challengeScalar.bits <== canonicalChallenge.bits;

    component terminalAddition = ExtendedJubjubAdd_unsafe();
    terminalAddition.point1 <== challengeScalar.result;
    terminalAddition.point2 <== randomizerCofactor.R8;

    component terminalEquality = AssertExtendedJubjubEqual_unsafe();
    terminalEquality.lhs <== responseScalar.result;
    terminalEquality.rhs <== terminalAddition.result;

    component publicKeyHasher = Poseidon255(2);
    publicKeyHasher.in[0] <== challengeInputs[2];
    publicKeyHasher.in[1] <== challengeInputs[3];

    component canonicalPublicKeyHash = CanonicalBls12381FieldBits();
    canonicalPublicKeyHash.in <== publicKeyHasher.out;

    var originLow = 0;
    for (var i = 0; i < 128; i++) {
        originLow += canonicalPublicKeyHash.bits[i] * (1 << i);
    }
    origin[0] <== originLow;
    var originHigh = 0;
    for (var i = 128; i < 160; i++) {
        originHigh += canonicalPublicKeyHash.bits[i] * (1 << (i - 128));
    }
    origin[1] <== originHigh;
}
