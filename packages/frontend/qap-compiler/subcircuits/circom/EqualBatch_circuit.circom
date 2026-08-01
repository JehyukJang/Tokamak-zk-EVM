pragma circom 2.1.6;
include "../../templates/256bit/equality.circom";
include "./constants.circom";

template EqualBatch(N) {
    signal input in[4 * N];

    component module = equalBatch(N);
    for (var i = 0; i < N; i++) {
        module.lhs[i] <== [in[2 * i], in[2 * i + 1]];
        module.rhs[i] <== [in[2 * N + 2 * i], in[2 * N + 2 * i + 1]];
    }
}

// Preserve the input interface during standalone Circom compilation.
// The qap-compiler remaps it to free wires when composing this subcircuit.
component main{public [in]} = EqualBatch(nEqualBatch());
