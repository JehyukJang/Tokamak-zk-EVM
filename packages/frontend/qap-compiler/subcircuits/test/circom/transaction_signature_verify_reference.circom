pragma circom 2.1.6;

include "../../../templates/255bit/jubjub.circom";

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

// Multiplies an already-valid Jubjub point by the curve cofactor. Completeness
// of jubjubAdd guarantees that all three doublings have nonzero denominators.
template JubjubMulByCofactor8FromValidPoint_unsafe() {
    signal input point[2];
    signal output point8[2];

    signal point2[2] <== jubjubAdd()(point, point);
    signal point4[2] <== jubjubAdd()(point2, point2);
    point8 <== jubjubAdd()(point4, point4);
}

// The affine addition formula used by jubjubAdd is complete for this curve:
// a = -1 is a square and d = -(10240/10241) is a nonsquare in BLS12-381 Fr.
// Consequently, all three doublings have nonzero denominators for an on-curve
// A, and every produced point remains on the same curve.
template TransactionSignaturePointValidationReference() {
    signal input A[2];
    signal input R[2];
    signal output A8[2];

    component checkA = jubjubCheck();
    checkA.in <== A;

    component checkR = jubjubCheck();
    checkR.in <== R;

    component publicKeyCofactor = JubjubMulByCofactor8FromValidPoint_unsafe();
    publicKeyCofactor.point <== A;
    A8 <== publicKeyCofactor.point8;

    component rejectA8Identity = RejectJubjubIdentityFromValidatedY_unsafe();
    rejectA8Identity.y <== A8[1];

    component rejectRIdentity = RejectJubjubIdentityFromValidatedY_unsafe();
    rejectRIdentity.y <== R[1];
}

// Computes the two remaining cofactor points used by the final verification
// equation. R is validated inside this reference circuit. G is an approved
// public constant whose exact value and curve validity are owned by Solidity.
template TransactionSignatureCofactorPointsReference() {
    signal input G[2];
    signal input R[2];
    signal output G8[2];
    signal output R8[2];

    component generatorCofactor = JubjubMulByCofactor8FromValidPoint_unsafe();
    generatorCofactor.point <== G;
    G8 <== generatorCofactor.point8;

    component randomizerCofactor = JubjubMulByCofactor8FromValidPoint_unsafe();
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

// This is the current executable stage of the non-production monolithic
// TransactionSignatureVerify reference. Its inputs are exactly the N + 7 word
// prefix of the final N + 12 operand interface:
//
// R.x, R.y, A.x, A.y, nonce, contract, selector, input[0..N-1].
//
// S, G, and O are declared separately so the diagnostic main can preserve their
// public boundary while all N + 7 challenge inputs remain private. They are
// logical operands N + 7 through N + 11 in the final ordered interface. The
// final reference will expose only origin. This stage exposes its intermediate
// values solely so their exact construction can be tested before the terminal
// equation and origin derivation are added.
template TransactionSignatureVerifyReferenceStage(N) {
    assert(N > 0);

    signal input in[N + 7][2];
    signal input S[2];
    signal input G[2][2];
    signal input O[2][2];
    signal output challenge[2];
    signal output challengeBits[255];
    signal output sBits[252];
    signal output A8[2];
    signal output G8[2];
    signal output R8[2];
    signal output sG8[2];
    signal output hA8[2];
    signal output signatureRhs[2];
    signal output publicKeyHash[2];
    signal output publicKeyHashBits[255];
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
    A8 <== pointValidation.A8;

    signal nativeG[2];
    for (var coordinate = 0; coordinate < 2; coordinate++) {
        nativeG[coordinate] <== G[coordinate][0] + G[coordinate][1] * LIMB_BASE;
    }

    component cofactorPoints = TransactionSignatureCofactorPointsReference();
    cofactorPoints.G <== nativeG;
    cofactorPoints.R <== [challengeInputs[0], challengeInputs[1]];
    G8 <== cofactorPoints.G8;
    R8 <== cofactorPoints.R8;

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

    // Solidity owns the exact public-limb checks and S < n. This relation only
    // reconstructs those same public limbs into the 252 bits required by the
    // fixed-base scalar multiplication. It must not reduce S modulo n.
    component signatureDecomposition = Num2Bits(252);
    signatureDecomposition.in <== S[0] + S[1] * LIMB_BASE;
    sBits <== signatureDecomposition.out;

    signal nativeO[2];
    for (var coordinate = 0; coordinate < 2; coordinate++) {
        nativeO[coordinate] <== O[coordinate][0] + O[coordinate][1] * LIMB_BASE;
    }

    component responseScalar = JubjubScalarMulFromConstrainedBits_unsafe(252);
    responseScalar.identity <== nativeO;
    responseScalar.base <== cofactorPoints.G8;
    responseScalar.bits <== signatureDecomposition.out;
    sG8 <== responseScalar.result;

    component challengeScalar = JubjubScalarMulFromConstrainedBits_unsafe(255);
    challengeScalar.identity <== nativeO;
    challengeScalar.base <== pointValidation.A8;
    challengeScalar.bits <== canonicalChallenge.bits;
    hA8 <== challengeScalar.result;

    component terminalAddition = jubjubAdd();
    terminalAddition.in1 <== cofactorPoints.R8;
    terminalAddition.in2 <== challengeScalar.result;
    signatureRhs <== terminalAddition.out;

    for (var coordinate = 0; coordinate < 2; coordinate++) {
        responseScalar.result[coordinate] === terminalAddition.out[coordinate];
    }

    component publicKeyHasher = Poseidon255(2);
    publicKeyHasher.in[0] <== challengeInputs[2];
    publicKeyHasher.in[1] <== challengeInputs[3];

    component canonicalPublicKeyHash = CanonicalBls12381FieldBits();
    canonicalPublicKeyHash.in <== publicKeyHasher.out;
    publicKeyHashBits <== canonicalPublicKeyHash.bits;

    var publicKeyHashLow = 0;
    var publicKeyHashHigh = 0;
    for (var i = 0; i < 128; i++) {
        publicKeyHashLow += canonicalPublicKeyHash.bits[i] * (1 << i);
    }
    for (var i = 128; i < 255; i++) {
        publicKeyHashHigh += canonicalPublicKeyHash.bits[i] * (1 << (i - 128));
    }
    publicKeyHash[0] <== publicKeyHashLow;
    publicKeyHash[1] <== publicKeyHashHigh;

    origin[0] <== publicKeyHashLow;
    var originHigh = 0;
    for (var i = 128; i < 160; i++) {
        originHigh += canonicalPublicKeyHash.bits[i] * (1 << (i - 128));
    }
    origin[1] <== originHigh;
}
