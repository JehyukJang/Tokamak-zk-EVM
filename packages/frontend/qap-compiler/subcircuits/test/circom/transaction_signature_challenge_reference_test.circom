pragma circom 2.1.6;

include "./transaction_signature_challenge_reference.circom";
include "../../circom/constants.circom";

component main = TransactionSignatureChallengeReference(nPrivateMessageInputs());
