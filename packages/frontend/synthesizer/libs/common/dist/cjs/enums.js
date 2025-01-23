"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConsensusAlgorithm = exports.ConsensusType = exports.Hardfork = exports.ChainGenesis = exports.Chain = void 0;
const util_1 = require("@ethereumjs/util");
var Chain;
(function (Chain) {
    Chain[Chain["Mainnet"] = 1] = "Mainnet";
    Chain[Chain["Goerli"] = 5] = "Goerli";
    Chain[Chain["Sepolia"] = 11155111] = "Sepolia";
    Chain[Chain["Holesky"] = 17000] = "Holesky";
    Chain[Chain["Kaustinen6"] = 69420] = "Kaustinen6";
})(Chain = exports.Chain || (exports.Chain = {}));
// Having this info as record will force typescript to make sure no chain is missed
/**
 * GenesisState info about well known ethereum chains
 */
exports.ChainGenesis = {
    [Chain.Mainnet]: {
        name: 'mainnet',
        blockNumber: util_1.BIGINT_0,
        stateRoot: (0, util_1.hexToBytes)('0xd7f8974fb5ac78d9ac099b9ad5018bedc2ce0a72dad1827a1709da30580f0544'),
    },
    [Chain.Goerli]: {
        name: 'goerli',
        blockNumber: util_1.BIGINT_0,
        stateRoot: (0, util_1.hexToBytes)('0x5d6cded585e73c4e322c30c2f782a336316f17dd85a4863b9d838d2d4b8b3008'),
    },
    [Chain.Sepolia]: {
        name: 'sepolia',
        blockNumber: util_1.BIGINT_0,
        stateRoot: (0, util_1.hexToBytes)('0x5eb6e371a698b8d68f665192350ffcecbbbf322916f4b51bd79bb6887da3f494'),
    },
    [Chain.Holesky]: {
        name: 'holesky',
        blockNumber: util_1.BIGINT_0,
        stateRoot: (0, util_1.hexToBytes)('0x69d8c9d72f6fa4ad42d4702b433707212f90db395eb54dc20bc85de253788783'),
    },
    [Chain.Kaustinen6]: {
        name: 'kaustinen6',
        blockNumber: util_1.BIGINT_0,
        stateRoot: (0, util_1.hexToBytes)('0x1fbf85345a3cbba9a6d44f991b721e55620a22397c2a93ee8d5011136ac300ee'),
    },
};
var Hardfork;
(function (Hardfork) {
    Hardfork["Chainstart"] = "chainstart";
    Hardfork["Homestead"] = "homestead";
    Hardfork["Dao"] = "dao";
    Hardfork["TangerineWhistle"] = "tangerineWhistle";
    Hardfork["SpuriousDragon"] = "spuriousDragon";
    Hardfork["Byzantium"] = "byzantium";
    Hardfork["Constantinople"] = "constantinople";
    Hardfork["Petersburg"] = "petersburg";
    Hardfork["Istanbul"] = "istanbul";
    Hardfork["MuirGlacier"] = "muirGlacier";
    Hardfork["Berlin"] = "berlin";
    Hardfork["London"] = "london";
    Hardfork["ArrowGlacier"] = "arrowGlacier";
    Hardfork["GrayGlacier"] = "grayGlacier";
    Hardfork["MergeForkIdTransition"] = "mergeForkIdTransition";
    Hardfork["Paris"] = "paris";
    Hardfork["Shanghai"] = "shanghai";
    Hardfork["Cancun"] = "cancun";
    Hardfork["Prague"] = "prague";
    Hardfork["Osaka"] = "osaka";
})(Hardfork = exports.Hardfork || (exports.Hardfork = {}));
var ConsensusType;
(function (ConsensusType) {
    ConsensusType["ProofOfStake"] = "pos";
    ConsensusType["ProofOfWork"] = "pow";
    ConsensusType["ProofOfAuthority"] = "poa";
})(ConsensusType = exports.ConsensusType || (exports.ConsensusType = {}));
var ConsensusAlgorithm;
(function (ConsensusAlgorithm) {
    ConsensusAlgorithm["Ethash"] = "ethash";
    ConsensusAlgorithm["Clique"] = "clique";
    ConsensusAlgorithm["Casper"] = "casper";
})(ConsensusAlgorithm = exports.ConsensusAlgorithm || (exports.ConsensusAlgorithm = {}));
//# sourceMappingURL=enums.js.map