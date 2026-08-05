pragma circom 2.1.6;

include "../../../templates/255bit/jubjub.circom";

template SelectPointByBits_unsafe(W) {
    assert(W >= 2);
    assert(W <= 4);

    var TABLE_SIZE = 1 << W;
    signal input table[TABLE_SIZE][2];
    signal input bits[W];
    signal output point[2];

    signal nodes[2 * TABLE_SIZE - 1][2];
    for (var index = 0; index < TABLE_SIZE; index++) {
        nodes[index] <== table[index];
    }

    var sourceStart = 0;
    var destinationStart = TABLE_SIZE;
    var sourceCount = TABLE_SIZE;
    for (var bit = 0; bit < W; bit++) {
        for (var pair = 0; pair < sourceCount \ 2; pair++) {
            for (var coordinate = 0; coordinate < 2; coordinate++) {
                nodes[destinationStart + pair][coordinate] <==
                    nodes[sourceStart + 2 * pair][coordinate]
                    + bits[bit] * (
                        nodes[sourceStart + 2 * pair + 1][coordinate]
                        - nodes[sourceStart + 2 * pair][coordinate]
                    );
            }
        }
        sourceStart = destinationStart;
        destinationStart += sourceCount \ 2;
        sourceCount \= 2;
    }

    point <== nodes[2 * TABLE_SIZE - 2];
}

// Left-to-right fixed-window multiplication for an already-valid variable
// base, an exact identity, and upstream-constrained LSB-first scalar bits.
template VariableBaseWindowScalarMulFromConstrainedBits_unsafe(N, W) {
    assert(N > 0);
    assert(W >= 2);
    assert(W <= 4);

    signal input identity[2];
    signal input base[2];
    signal input bits[N];
    signal output result[2];

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

    signal accumulators[NUM_WINDOWS + 1][2];
    accumulators[0] <== identity;
    component doublings[(NUM_WINDOWS - 1) * W];
    component additions[NUM_WINDOWS];
    for (var step = 0; step < NUM_WINDOWS; step++) {
        additions[step] = jubjubAdd();
        if (step == 0) {
            additions[step].in1 <== accumulators[step];
        } else {
            var doublingStart = (step - 1) * W;
            doublings[doublingStart] = jubjubAdd();
            doublings[doublingStart].in1 <== accumulators[step];
            doublings[doublingStart].in2 <== accumulators[step];
            for (var doubling = 1; doubling < W; doubling++) {
                doublings[doublingStart + doubling] = jubjubAdd();
                doublings[doublingStart + doubling].in1 <==
                    doublings[doublingStart + doubling - 1].out;
                doublings[doublingStart + doubling].in2 <==
                    doublings[doublingStart + doubling - 1].out;
            }
            additions[step].in1 <== doublings[doublingStart + W - 1].out;
        }
        additions[step].in2 <== selectors[step].point;
        accumulators[step + 1] <== additions[step].out;
    }

    result <== accumulators[NUM_WINDOWS];
}
