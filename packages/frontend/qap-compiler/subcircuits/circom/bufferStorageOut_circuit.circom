pragma circom 2.1.6;
include "../../templates/buffer.circom";
include "./constants.circom";

// Input wires are private, and output wires are public.
// Each SSTORE record contains three 256-bit values represented by two limbs each.
component main{public [in]} = Buffer2(nSstore() * 3 * 2);
