pragma circom 2.1.6;
include "../../templates/buffer.circom";
include "./constants.circom";

// Preserve both interfaces during standalone Circom compilation.
// The qap-compiler remaps them to free wires when composing this subcircuit.
component main{public [in]} = Buffer2(2 * nEqualBatch());
