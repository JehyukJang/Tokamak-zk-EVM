pragma circom 2.1.6;
include "../../templates/buffer.circom";
include "./constants.circom";

// Input wires are public, and output wires are private.
// Each SLOAD record contains three 256-bit values represented by two limbs each.
component main{public [in]} = Buffer2(nPubIn() + nSload() * 3 * 2);
