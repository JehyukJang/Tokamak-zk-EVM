"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPresetChainConfig = exports.parseGethGenesis = void 0;
const util_1 = require("@ethereumjs/util");
const chains_js_1 = require("./chains.js");
const enums_js_1 = require("./enums.js");
/**
 * Transforms Geth formatted nonce (i.e. hex string) to 8 byte 0x-prefixed string used internally
 * @param nonce string parsed from the Geth genesis file
 * @returns nonce as a 0x-prefixed 8 byte string
 */
function formatNonce(nonce) {
    if (!nonce || nonce === '0x0') {
        return '0x0000000000000000';
    }
    if ((0, util_1.isHexString)(nonce)) {
        return `0x${(0, util_1.stripHexPrefix)(nonce).padStart(16, '0')}`;
    }
    return `0x${nonce.padStart(16, '0')}`;
}
/**
 * Converts Geth genesis parameters to an EthereumJS compatible `CommonOpts` object
 * @param json object representing the Geth genesis file
 * @returns genesis parameters in a `CommonOpts` compliant object
 */
function parseGethParams(json) {
    const { name, config, difficulty, mixHash, gasLimit, coinbase, baseFeePerGas, excessBlobGas, extraData: unparsedExtraData, nonce: unparsedNonce, timestamp: unparsedTimestamp, } = json;
    const genesisTimestamp = Number(unparsedTimestamp);
    const { chainId, depositContractAddress, } = config;
    // geth is not strictly putting empty fields with a 0x prefix
    const extraData = unparsedExtraData === '' ? '0x' : unparsedExtraData;
    // geth may use number for timestamp
    const timestamp = (0, util_1.isHexString)(unparsedTimestamp)
        ? unparsedTimestamp
        : (0, util_1.intToHex)(parseInt(unparsedTimestamp));
    // geth may not give us a nonce strictly formatted to an 8 byte 0x-prefixed hex string
    const nonce = unparsedNonce.length !== 18 ? formatNonce(unparsedNonce) : unparsedNonce;
    // EIP155 and EIP158 are both part of Spurious Dragon hardfork and must occur at the same time
    // but have different configuration parameters in geth genesis parameters
    if (config.eip155Block !== config.eip158Block) {
        throw new Error('EIP155 block number must equal EIP 158 block number since both are part of SpuriousDragon hardfork and the client only supports activating the full hardfork');
    }
    // Terminal total difficulty logic is not supported any more as the merge has been completed
    // so the Merge/Paris hardfork block must be 0
    if (config.terminalTotalDifficulty !== undefined &&
        (BigInt(difficulty) < BigInt(config.terminalTotalDifficulty) ||
            config.terminalTotalDifficultyPassed === false)) {
        throw new Error('nonzero terminal total difficulty is not supported');
    }
    const params = {
        name,
        chainId,
        depositContractAddress,
        genesis: {
            timestamp,
            gasLimit,
            difficulty,
            nonce,
            extraData,
            mixHash,
            coinbase,
            baseFeePerGas,
            excessBlobGas,
        },
        hardfork: undefined,
        hardforks: [],
        bootstrapNodes: [],
        consensus: config.clique !== undefined
            ? {
                type: 'poa',
                algorithm: 'clique',
                clique: {
                    // The recent geth genesis seems to be using blockperiodseconds // cspell:disable-line
                    // and epochlength for clique specification
                    // see: https://hackmd.io/PqZgMpnkSWCWv5joJoFymQ
                    period: config.clique.period ?? config.clique.blockperiodseconds,
                    epoch: config.clique.epoch ?? config.clique.epochlength,
                },
            }
            : {
                type: 'pow',
                algorithm: 'ethash',
                ethash: {},
            },
    };
    const forkMap = {
        [enums_js_1.Hardfork.Homestead]: { name: 'homesteadBlock' },
        [enums_js_1.Hardfork.Dao]: { name: 'daoForkBlock' },
        [enums_js_1.Hardfork.TangerineWhistle]: { name: 'eip150Block' },
        [enums_js_1.Hardfork.SpuriousDragon]: { name: 'eip155Block' },
        [enums_js_1.Hardfork.Byzantium]: { name: 'byzantiumBlock' },
        [enums_js_1.Hardfork.Constantinople]: { name: 'constantinopleBlock' },
        [enums_js_1.Hardfork.Petersburg]: { name: 'petersburgBlock' },
        [enums_js_1.Hardfork.Istanbul]: { name: 'istanbulBlock' },
        [enums_js_1.Hardfork.MuirGlacier]: { name: 'muirGlacierBlock' },
        [enums_js_1.Hardfork.Berlin]: { name: 'berlinBlock' },
        [enums_js_1.Hardfork.London]: { name: 'londonBlock' },
        [enums_js_1.Hardfork.MergeForkIdTransition]: { name: 'mergeForkBlock', postMerge: true },
        [enums_js_1.Hardfork.Shanghai]: { name: 'shanghaiTime', postMerge: true, isTimestamp: true },
        [enums_js_1.Hardfork.Cancun]: { name: 'cancunTime', postMerge: true, isTimestamp: true },
        [enums_js_1.Hardfork.Prague]: { name: 'pragueTime', postMerge: true, isTimestamp: true },
        [enums_js_1.Hardfork.Osaka]: { name: 'osakaTime', postMerge: true, isTimestamp: true },
    };
    // forkMapRev is the map from config field name to Hardfork
    const forkMapRev = Object.keys(forkMap).reduce((acc, elem) => {
        acc[forkMap[elem].name] = elem;
        return acc;
    }, {});
    const configHardforkNames = Object.keys(config).filter((key) => forkMapRev[key] !== undefined && config[key] !== undefined && config[key] !== null);
    params.hardforks = configHardforkNames
        .map((nameBlock) => ({
        name: forkMapRev[nameBlock],
        block: forkMap[forkMapRev[nameBlock]].isTimestamp === true || typeof config[nameBlock] !== 'number'
            ? null
            : config[nameBlock],
        timestamp: forkMap[forkMapRev[nameBlock]].isTimestamp === true && typeof config[nameBlock] === 'number'
            ? config[nameBlock]
            : undefined,
    }))
        .filter((fork) => fork.block !== null || fork.timestamp !== undefined);
    params.hardforks.sort(function (a, b) {
        return (a.block ?? Infinity) - (b.block ?? Infinity);
    });
    params.hardforks.sort(function (a, b) {
        // non timestamp forks come before any timestamp forks
        return (a.timestamp ?? 0) - (b.timestamp ?? 0);
    });
    // only set the genesis timestamp forks to zero post the above sort has happened
    // to get the correct sorting
    for (const hf of params.hardforks) {
        if (hf.timestamp === genesisTimestamp) {
            hf.timestamp = 0;
        }
    }
    if (config.terminalTotalDifficulty !== undefined) {
        // Merge fork must be placed at 0 since ttd logic is no longer supported
        const mergeConfig = {
            name: enums_js_1.Hardfork.Paris,
            block: 0,
            timestamp: undefined,
        };
        // Merge hardfork has to be placed before first hardfork that is dependent on merge
        const postMergeIndex = params.hardforks.findIndex((hf) => forkMap[hf.name]?.postMerge === true);
        if (postMergeIndex !== -1) {
            params.hardforks.splice(postMergeIndex, 0, mergeConfig);
        }
        else {
            params.hardforks.push(mergeConfig);
        }
    }
    const latestHardfork = params.hardforks.length > 0 ? params.hardforks.slice(-1)[0] : undefined;
    params.hardfork = latestHardfork?.name;
    params.hardforks.unshift({ name: enums_js_1.Hardfork.Chainstart, block: 0 });
    return params;
}
/**
 * Parses a genesis.json exported from Geth into parameters for Common instance
 * @param json representing the Geth genesis file
 * @param name optional chain name
 * @returns parsed params
 */
function parseGethGenesis(json, name) {
    try {
        const required = ['config', 'difficulty', 'gasLimit', 'nonce', 'alloc'];
        if (required.some((field) => !(field in json))) {
            const missingField = required.filter((field) => !(field in json));
            throw new Error(`Invalid format, expected geth genesis field "${missingField}" missing`);
        }
        // We copy the JSON object here because it's frozen in browser and properties can't be modified
        const finalJSON = { ...json };
        if (name !== undefined) {
            finalJSON.name = name;
        }
        return parseGethParams(finalJSON);
    }
    catch (e) {
        throw new Error(`Error parsing parameters file: ${e.message}`);
    }
}
exports.parseGethGenesis = parseGethGenesis;
/**
 * Return the preset chain config for one of the predefined chain configurations
 * @param chain the representing a network name (e.g. 'mainnet') or number representing the chain ID
 * @returns a {@link ChainConfig}
 */
const getPresetChainConfig = (chain) => {
    switch (chain) {
        case 'goerli':
        case 5:
            return chains_js_1.Goerli;
        case 'holesky':
        case 17000:
            return chains_js_1.Holesky;
        case 'kaustinen6':
        case 69420:
            return chains_js_1.Kaustinen6;
        case 'sepolia':
        case 11155111:
            return chains_js_1.Sepolia;
        case 'mainnet':
        case 1:
        default:
            return chains_js_1.Mainnet;
    }
};
exports.getPresetChainConfig = getPresetChainConfig;
//# sourceMappingURL=utils.js.map