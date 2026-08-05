pragma circom 2.1.6;

include "./transaction_signature_fixed_base_window.circom";
include "./transaction_signature_variable_base_extended_window.circom";

// Keeps the fixed-base accumulator in complete extended coordinates. The
// compile-time table supplies x, y, and T=x*y through one shared selector basis.
template FixedG8ExtendedWindowScalarMulFromConstrainedBits_unsafe(N, W) {
    assert(N > 0);
    assert(W >= 2);
    assert(W <= 4);
    assert(N % W == 0);

    signal input bits[N];
    signal output result[4];

    var NUM_WINDOWS = N \ W;
    var TABLE_SIZE = 1 << W;
    var NUM_PRODUCTS = TABLE_SIZE - W - 1;
    var G8[2] = [
        52363696936650001301287582521711853146588465673974699354184720335305084401224,
        12024993157431732930272824407495979791132374572895036891122288541794509830761
    ];

    var table[NUM_WINDOWS][TABLE_SIZE][3];
    var coefficients[NUM_WINDOWS][TABLE_SIZE][3];
    var windowBase[2] = G8;
    for (var window = 0; window < NUM_WINDOWS; window++) {
        table[window][0] = [0, 1, 0];
        for (var digit = 1; digit < TABLE_SIZE; digit++) {
            var point[2] = fixedJubjubAdd(
                [table[window][digit - 1][0], table[window][digit - 1][1]],
                windowBase
            );
            table[window][digit] = [point[0], point[1], point[0] * point[1]];
        }

        for (var digit = 0; digit < TABLE_SIZE; digit++) {
            coefficients[window][digit] = table[window][digit];
        }
        for (var bit = 0; bit < W; bit++) {
            for (var mask = 0; mask < TABLE_SIZE; mask++) {
                if (((mask >> bit) & 1) == 1) {
                    for (var coordinate = 0; coordinate < 3; coordinate++) {
                        coefficients[window][mask][coordinate] -=
                            coefficients[window][mask - (1 << bit)][coordinate];
                    }
                }
            }
        }

        for (var bit = 0; bit < W; bit++) {
            windowBase = fixedJubjubAdd(windowBase, windowBase);
        }
    }

    var productIndex[TABLE_SIZE];
    var nextProduct = 0;
    for (var mask = 0; mask < TABLE_SIZE; mask++) {
        productIndex[mask] = -1;
        if (bitCount(mask, W) >= 2) {
            productIndex[mask] = nextProduct;
            nextProduct++;
        }
    }

    signal products[NUM_WINDOWS][NUM_PRODUCTS];
    signal selected[NUM_WINDOWS][3];
    for (var window = 0; window < NUM_WINDOWS; window++) {
        for (var mask = 1; mask < TABLE_SIZE; mask++) {
            if (bitCount(mask, W) >= 2) {
                var factorBit = onlyBitIndex(mask & (0 - mask), W);
                var previousMask = mask - (1 << factorBit);
                if (bitCount(previousMask, W) == 1) {
                    var previousBit = onlyBitIndex(previousMask, W);
                    products[window][productIndex[mask]] <==
                        bits[window * W + factorBit]
                        * bits[window * W + previousBit];
                } else {
                    products[window][productIndex[mask]] <==
                        bits[window * W + factorBit]
                        * products[window][productIndex[previousMask]];
                }
            }
        }

        for (var coordinate = 0; coordinate < 3; coordinate++) {
            var selectedExpression = coefficients[window][0][coordinate];
            for (var mask = 1; mask < TABLE_SIZE; mask++) {
                if (bitCount(mask, W) == 1) {
                    var bit = onlyBitIndex(mask, W);
                    selectedExpression += coefficients[window][mask][coordinate]
                        * bits[window * W + bit];
                } else {
                    selectedExpression += coefficients[window][mask][coordinate]
                        * products[window][productIndex[mask]];
                }
            }
            selected[window][coordinate] <== selectedExpression;
        }
    }

    signal accumulators[NUM_WINDOWS + 1][4];
    accumulators[0] <== [0, 1, 1, 0];
    component additions[NUM_WINDOWS];
    for (var window = 0; window < NUM_WINDOWS; window++) {
        additions[window] = ExtendedJubjubAddAffineWithT_unsafe();
        additions[window].point <== accumulators[window];
        additions[window].affine <== selected[window];
        accumulators[window + 1] <== additions[window].result;
    }

    result <== accumulators[NUM_WINDOWS];
}
