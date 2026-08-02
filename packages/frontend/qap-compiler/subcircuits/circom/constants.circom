pragma circom 2.1.6;
// Buffer capacities are measured in 256-bit words.
function nTxIn() {return 3;}
function nStorageLoad() {return 20;}
function nLogOut() {return 20;}
function nStorageStore() {return 15;}
function nEVMIn() {return 250;}
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
