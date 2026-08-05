pragma circom 2.1.6;

include "./transaction_signature_variable_base_window.circom";

// Complete a = -1 extended-coordinate doubling from the Explicit-Formulas
// Database. The input must already represent a valid extended Jubjub point.
template ExtendedJubjubDouble_unsafe() {
    signal input point[4];
    signal output result[4];

    signal A <== point[0] * point[0];
    signal B <== point[1] * point[1];
    signal C <== 2 * point[2] * point[2];
    signal E <== (point[0] + point[1]) * (point[0] + point[1]) - A - B;

    result[0] <== E * (-A + B - C);
    result[1] <== (-A + B) * (-A - B);
    result[2] <== (-A + B - C) * (-A + B);
    result[3] <== E * (-A - B);
}

// Complete mixed addition for an extended first point and an affine second
// point. The second point's T coordinate is derived locally from exact x,y.
template ExtendedJubjubAddAffine_unsafe() {
    signal input point[4];
    signal input affine[2];
    signal output result[4];

    var constants[3] = jubjubconst();
    var K = 2 * constants[1];

    signal affineT <== affine[0] * affine[1];
    signal A <== (point[1] - point[0]) * (affine[1] - affine[0]);
    signal B <== (point[1] + point[0]) * (affine[1] + affine[0]);
    signal C <== K * point[3] * affineT;

    result[0] <== (B - A) * (2 * point[2] - C);
    result[1] <== (2 * point[2] + C) * (B + A);
    result[2] <== (2 * point[2] - C) * (2 * point[2] + C);
    result[3] <== (B - A) * (B + A);
}

// Complete mixed addition when the exact affine T = x*y coordinate is already
// available, as it is for a compile-time table selection.
template ExtendedJubjubAddAffineWithT_unsafe() {
    signal input point[4];
    signal input affine[3];
    signal output result[4];

    var constants[3] = jubjubconst();
    var K = 2 * constants[1];

    signal A <== (point[1] - point[0]) * (affine[1] - affine[0]);
    signal B <== (point[1] + point[0]) * (affine[1] + affine[0]);
    signal C <== K * point[3] * affine[2];

    result[0] <== (B - A) * (2 * point[2] - C);
    result[1] <== (2 * point[2] + C) * (B + A);
    result[2] <== (2 * point[2] - C) * (2 * point[2] + C);
    result[3] <== (B - A) * (B + A);
}

// Complete addition of two exact extended-coordinate points.
template ExtendedJubjubAdd_unsafe() {
    signal input point1[4];
    signal input point2[4];
    signal output result[4];

    var constants[3] = jubjubconst();
    var K = 2 * constants[1];

    signal A <== (point1[1] - point1[0]) * (point2[1] - point2[0]);
    signal B <== (point1[1] + point1[0]) * (point2[1] + point2[0]);
    signal C <== K * point1[3] * point2[3];
    signal D <== 2 * point1[2] * point2[2];

    result[0] <== (B - A) * (D - C);
    result[1] <== (D + C) * (B + A);
    result[2] <== (D - C) * (D + C);
    result[3] <== (B - A) * (B + A);
}

template AffineJubjubMulByCofactor8Extended_unsafe() {
    signal input point[2];
    signal output point8[4];

    signal extended[4] <== [point[0], point[1], 1, point[0] * point[1]];
    component point2 = ExtendedJubjubDouble_unsafe();
    component point4 = ExtendedJubjubDouble_unsafe();
    component point8Component = ExtendedJubjubDouble_unsafe();
    point2.point <== extended;
    point4.point <== point2.result;
    point8Component.point <== point4.result;
    point8 <== point8Component.result;
}

// Uses affine runtime-table selection but keeps the accumulator in complete
// extended coordinates. This isolates coordinate-system cost without changing
// scalar digit decomposition or table semantics.
template VariableBaseExtendedWindowScalarMulFromConstrainedBits_unsafe(N, W) {
    assert(N > 0);
    assert(W >= 2);
    assert(W <= 4);

    signal input identity[2];
    signal input base[2];
    signal input bits[N];
    signal output result[4];

    var TABLE_SIZE = 1 << W;
    var NUM_WINDOWS = (N + W - 1) \ W;

    signal table[TABLE_SIZE][2];
    table[0] <== identity;
    table[1] <== base;
    component tableAdditions[TABLE_SIZE - 2];
    for (var digit = 2; digit < TABLE_SIZE; digit++) {
        tableAdditions[digit - 2] = jubjubAdd();
        tableAdditions[digit - 2].in1 <== table[digit - 1];
        tableAdditions[digit - 2].in2 <== base;
        table[digit] <== tableAdditions[digit - 2].out;
    }

    component selectors[NUM_WINDOWS];
    for (var step = 0; step < NUM_WINDOWS; step++) {
        selectors[step] = SelectPointByBits_unsafe(W);
        selectors[step].table <== table;
        var sourceWindow = NUM_WINDOWS - step - 1;
        for (var bit = 0; bit < W; bit++) {
            var scalarBit = sourceWindow * W + bit;
            if (scalarBit < N) {
                selectors[step].bits[bit] <== bits[scalarBit];
            } else {
                selectors[step].bits[bit] <== 0;
            }
        }
    }

    signal accumulators[NUM_WINDOWS + 1][4];
    accumulators[0] <== [identity[0], identity[1], 1, identity[0] * identity[1]];
    component doublings[(NUM_WINDOWS - 1) * W];
    component additions[NUM_WINDOWS];
    for (var step = 0; step < NUM_WINDOWS; step++) {
        additions[step] = ExtendedJubjubAddAffine_unsafe();
        if (step == 0) {
            additions[step].point <== accumulators[step];
        } else {
            var doublingStart = (step - 1) * W;
            doublings[doublingStart] = ExtendedJubjubDouble_unsafe();
            doublings[doublingStart].point <== accumulators[step];
            for (var doubling = 1; doubling < W; doubling++) {
                doublings[doublingStart + doubling] = ExtendedJubjubDouble_unsafe();
                doublings[doublingStart + doubling].point <==
                    doublings[doublingStart + doubling - 1].result;
            }
            additions[step].point <== doublings[doublingStart + W - 1].result;
        }
        additions[step].affine <== selectors[step].point;
        accumulators[step + 1] <== additions[step].result;
    }

    result <== accumulators[NUM_WINDOWS];
}

template ExtendedJubjubToAffine_unsafe() {
    signal input point[4];
    signal output affine[2];

    affine[0] <-- point[0] / point[2];
    affine[1] <-- point[1] / point[2];
    point[0] === affine[0] * point[2];
    point[1] === affine[1] * point[2];
}
