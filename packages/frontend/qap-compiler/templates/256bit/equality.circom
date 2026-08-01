pragma circom 2.1.6;

// Each 256-bit value is represented by two 128-bit little-endian limbs.
template equalBatch(N) {
    signal input lhs[N][2];
    signal input rhs[N][2];

    for (var i = 0; i < N; i++) {
        for (var j = 0; j < 2; j++) {
            (lhs[i][j] - rhs[i][j]) * (lhs[i][j] - rhs[i][j]) === 0;
            // Keep both limbs in the C matrix without a linear substitution.
            (lhs[i][j] + rhs[i][j]) * (lhs[i][j] - rhs[i][j]) === lhs[i][j] - rhs[i][j];
        }
    }
}
