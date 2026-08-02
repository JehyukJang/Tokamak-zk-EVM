pragma circom 2.1.6;
include "../../templates/256bit/compare_safe.circom";

template CheckBus_() {
    signal input in[2];

    component check = CheckBus();
    check.in <== in;
}

// Preserve the input interface during standalone Circom compilation.
component main {public [in]} = CheckBus_();
