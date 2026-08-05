pragma circom 2.1.6;

include "./transaction_signature_verify_reference.circom";
include "../../circom/constants.circom";

component main {public [S, G, O]} = TransactionSignatureVerifyReferenceStage(nPrivateMessageInputs());
