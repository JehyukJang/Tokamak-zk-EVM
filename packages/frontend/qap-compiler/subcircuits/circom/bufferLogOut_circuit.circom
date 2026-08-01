pragma circom 2.1.6;
include "../../templates/buffer.circom";
include "./constants.circom";

// Input wires are private, and output wires are public.
// Each log record contains two 256-bit values represented by two limbs each.
component main{public [in]} = Buffer2(nLog() * 2 * 2);
