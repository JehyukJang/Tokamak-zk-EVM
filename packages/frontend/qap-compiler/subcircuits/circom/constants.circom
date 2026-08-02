pragma circom 2.1.6;
// Buffer capacities are measured in 256-bit words.
function nTxIn() {return 3;}
function nStorageLoad() {return 15;}
function nLogOut() {return 15;}
function nStorageStore() {return 10;}
function nEVMIn() {return 210;}
function nPrvIn() {return 40;}

function nPoseidonInputs() {return 2;}
function nPoseidonBatch() {return 3;}
function nMtDepth() {return 36;}
function nMtLeaves() {return nPoseidonInputs() ** nMtDepth();}
function nAccumulation() {return 32;}
function nPrevBlockHashes() {return 4;}
function nJubjubExpBatch() {return 75;}
function nSubExpBatch() {return 16;}
function nEqualBatch() {return 2;}
