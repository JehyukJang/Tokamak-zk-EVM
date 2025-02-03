/**
 * Run this file with:
 * DEBUG=ethjs,evm:*,evm:*:* tsx erc20-transfer.ts
 */

import { Account, Address, hexToBytes } from "@ethereumjs/util/index.js"
import { keccak256 } from 'ethereum-cryptography/keccak'

import { createEVM } from '../../src/constructors.js'
import { finalize } from '../../src/tokamak/core/finalize.js'

// USDC contract bytecode
const contractProxyCode = '0x60806040526004361061006d576000357c0100000000000000000000000000000000000000000000000000000000900463ffffffff1680633659cfe6146100775780634f1ef286146100ba5780635c60da1b146101085780638f2839701461015f578063f851a440146101a2575b6100756101f9565b005b34801561008357600080fd5b506100b8600480360381019080803573ffffffffffffffffffffffffffffffffffffffff169060200190929190505050610213565b005b610106600480360381019080803573ffffffffffffffffffffffffffffffffffffffff169060200190929190803590602001908201803590602001919091929391929390505050610268565b005b34801561011457600080fd5b5061011d610308565b604051808273ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200191505060405180910390f35b34801561016b57600080fd5b506101a0600480360381019080803573ffffffffffffffffffffffffffffffffffffffff169060200190929190505050610360565b005b3480156101ae57600080fd5b506101b761051e565b604051808273ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200191505060405180910390f35b610201610576565b61021161020c610651565b610682565b565b61021b6106a8565b73ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff16141561025c57610257816106d9565b610265565b6102646101f9565b5b50565b6102706106a8565b73ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff1614156102fa576102ac836106d9565b3073ffffffffffffffffffffffffffffffffffffffff163483836040518083838082843782019150509250505060006040518083038185875af19250505015156102f557600080fd5b610303565b6103026101f9565b5b505050565b60006103126106a8565b73ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff1614156103545761034d610651565b905061035d565b61035c6101f9565b5b90565b6103686106a8565b73ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff16141561051257600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614151515610466576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260368152602001807f43616e6e6f74206368616e6765207468652061646d696e206f6620612070726f81526020017f787920746f20746865207a65726f20616464726573730000000000000000000081525060400191505060405180910390fd5b7f7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f61048f6106a8565b82604051808373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020018273ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019250505060405180910390a161050d81610748565b61051b565b61051a6101f9565b5b50565b60006105286106a8565b73ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff16141561056a576105636106a8565b9050610573565b6105726101f9565b5b90565b61057e6106a8565b73ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff1614151515610647576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260328152602001807f43616e6e6f742063616c6c2066616c6c6261636b2066756e6374696f6e20667281526020017f6f6d207468652070726f78792061646d696e000000000000000000000000000081525060400191505060405180910390fd5b61064f610777565b565b6000807f7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c36001029050805491505090565b3660008037600080366000845af43d6000803e80600081146106a3573d6000f35b3d6000fd5b6000807f10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b6001029050805491505090565b6106e281610779565b7fbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b81604051808273ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200191505060405180910390a150565b60007f10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b60010290508181555050565b565b60006107848261084b565b151561081e576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040180806020018281038252603b8152602001807f43616e6e6f742073657420612070726f787920696d706c656d656e746174696f81526020017f6e20746f2061206e6f6e2d636f6e74726163742061646472657373000000000081525060400191505060405180910390fd5b7f7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c360010290508181555050565b600080823b9050600081119150509190505600a165627a7a72305820a4a547cfc7202c5acaaae74d428e988bc62ad5024eb0165532d3a8f91db4ed240029'
const contractCode = '0x60806040526004361061018b576000357c0100000000000000000000000000000000000000000000000000000000900463ffffffff16806306fdde0314610190578063095ea7b31461022057806318160ddd146102855780631a895266146102b057806323b872dd146102f35780633092afd514610378578063313ce567146103d35780633357162b1461040457806335d99f35146105865780633f4ba83a146105dd57806340c10f19146105f457806342966c68146106595780634e44d95614610686578063554bab3c146106eb5780635c975abb1461072e57806370a082311461075d5780638456cb59146107b45780638a6db9c3146107cb5780638da5cb5b1461082257806395d89b41146108795780639fd0506d14610909578063a9059cbb14610960578063aa20e1e4146109c5578063aa271e1a14610a08578063ad38bf2214610a63578063bd10243014610aa6578063dd62ed3e14610afd578063e5a6b10f14610b74578063f2fde38b14610c04578063f9f92be414610c47578063fe575a8714610c8a575b600080fd5b34801561019c57600080fd5b506101a5610ce5565b6040518080602001828103825283818151815260200191508051906020019080838360005b838110156101e55780820151818401526020810190506101ca565b50505050905090810190601f1680156102125780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b34801561022c57600080fd5b5061026b600480360381019080803573ffffffffffffffffffffffffffffffffffffffff16906020019092919080359060200190929190505050610d83565b604051808215151515815260200191505060405180910390f35b34801561029157600080fd5b5061029a610f53565b6040518082815260200191505060405180910390f35b3480156102bc57600080fd5b506102f1600480360381019080803573ffffffffffffffffffffffffffffffffffffffff169060200190929190505050610f5d565b005b3480156102ff57600080fd5b5061035e600480360381019080803573ffffffffffffffffffffffffffffffffffffffff169060200190929190803573ffffffffffffffffffffffffffffffffffffffff16906020019092919080359060200190929190505050611057565b604051808215151515815260200191505060405180910390f35b34801561038457600080fd5b506103b9600480360381019080803573ffffffffffffffffffffffffffffffffffffffff169060200190929190505050611556565b604051808215151515815260200191505060405180910390f35b3480156103df57600080fd5b506103e861169d565b604051808260ff1660ff16815260200191505060405180910390f35b34801561041057600080fd5b50610584600480360381019080803590602001908201803590602001908080601f0160208091040260200160405190810160405280939291908181526020018383808284378201915050505050509192919290803590602001908201803590602001908080601f0160208091040260200160405190810160405280939291908181526020018383808284378201915050505050509192919290803590602001908201803590602001908080601f0160208091040260200160405190810160405280939291908181526020018383808284378201915050505050509192919290803560ff169060200190929190803573ffffffffffffffffffffffffffffffffffffffff169060200190929190803573ffffffffffffffffffffffffffffffffffffffff169060200190929190803573ffffffffffffffffffffffffffffffffffffffff169060200190929190803573ffffffffffffffffffffffffffffffffffffffff1690602001909291905050506116b0565b005b34801561059257600080fd5b5061059b61190d565b604051808273ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200191505060405180910390f35b3480156105e957600080fd5b506105f2611933565b005b34801561060057600080fd5b5061063f600480360381019080803573ffffffffffffffffffffffffffffffffffffffff169060200190929190803590602001909291905050506119d8565b604051808215151515815260200191505060405180910390f35b34801561066557600080fd5b5061068460048036038101908080359060200190929190505050611d7a565b005b34801561069257600080fd5b506106d1600480360381019080803573ffffffffffffffffffffffffffffffffffffffff16906020019092919080359060200190929190505050611fe1565b604051808215151515815260200191505060405180910390f35b3480156106f757600080fd5b5061072c600480360381019080803573ffffffffffffffffffffffffffffffffffffffff16906020019092919050505061214f565b005b34801561073a57600080fd5b50610743612275565b604051808215151515815260200191505060405180910390f35b34801561076957600080fd5b5061079e600480360381019080803573ffffffffffffffffffffffffffffffffffffffff169060200190929190505050612288565b6040518082815260200191505060405180910390f35b3480156107c057600080fd5b506107c96122d1565b005b3480156107d757600080fd5b5061080c600480360381019080803573ffffffffffffffffffffffffffffffffffffffff169060200190929190505050612375565b6040518082815260200191505060405180910390f35b34801561082e57600080fd5b506108376123be565b604051808273ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200191505060405180910390f35b34801561088557600080fd5b5061088e6123e7565b6040518080602001828103825283818151815260200191508051906020019080838360005b838110156108ce5780820151818401526020810190506108b3565b50505050905090810190601f1680156108fb5780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b34801561091557600080fd5b5061091e612485565b604051808273ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200191505060405180910390f35b34801561096c57600080fd5b506109ab600480360381019080803573ffffffffffffffffffffffffffffffffffffffff169060200190929190803590602001909291905050506124ab565b604051808215151515815260200191505060405180910390f35b3480156109d157600080fd5b50610a06600480360381019080803573ffffffffffffffffffffffffffffffffffffffff1690602001909291905050506127ae565b005b348015610a1457600080fd5b50610a49600480360381019080803573ffffffffffffffffffffffffffffffffffffffff1690602001909291905050506128d4565b604051808215151515815260200191505060405180910390f35b348015610a6f57600080fd5b50610aa4600480360381019080803573ffffffffffffffffffffffffffffffffffffffff16906020019092919050505061292a565b005b348015610ab257600080fd5b50610abb612a50565b604051808273ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200191505060405180910390f35b348015610b0957600080fd5b50610b5e600480360381019080803573ffffffffffffffffffffffffffffffffffffffff169060200190929190803573ffffffffffffffffffffffffffffffffffffffff169060200190929190505050612a76565b6040518082815260200191505060405180910390f35b348015610b8057600080fd5b50610b89612afd565b6040518080602001828103825283818151815260200191508051906020019080838360005b83811015610bc9578082015181840152602081019050610bae565b50505050905090810190601f168015610bf65780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b348015610c1057600080fd5b50610c45600480360381019080803573ffffffffffffffffffffffffffffffffffffffff169060200190929190505050612b9b565b005b348015610c5357600080fd5b50610c88600480360381019080803573ffffffffffffffffffffffffffffffffffffffff169060200190929190505050612cc2565b005b348015610c9657600080fd5b50610ccb600480360381019080803573ffffffffffffffffffffffffffffffffffffffff169060200190929190505050612dbc565b604051808215151515815260200191505060405180910390f35b60048054600181600116156101000203166002900480601f016020809104026020016040519081016040528092919081815260200182805460018160011615610100020316600290048015610d7b5780601f10610d5057610100808354040283529160200191610d7b565b820191906000526020600020905b815481529060010190602001808311610d5e57829003601f168201915b505050505081565b6000600160149054906101000a900460ff16151515610da157600080fd5b3360001515600360008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060009054906101000a900460ff161515141515610e0157600080fd5b8360001515600360008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060009054906101000a900460ff161515141515610e6157600080fd5b83600a60003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060008773ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020819055508473ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff167f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925866040518082815260200191505060405180910390a360019250505092915050565b6000600b54905090565b600260009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff16141515610fb957600080fd5b6000600360008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060006101000a81548160ff0219169083151502179055508073ffffffffffffffffffffffffffffffffffffffff167f117e3210bb9aa7d9baff172026820255c6f6c30ba8999d1c2fd88e2848137c4e60405160405180910390a250565b6000600160149054906101000a900460ff1615151561107557600080fd5b8260001515600360008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060009054906101000a900460ff1615151415156110d557600080fd5b3360001515600360008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060009054906101000a900460ff16151514151561113557600080fd5b8560001515600360008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060009054906101000a900460ff16151514151561119557600080fd5b600073ffffffffffffffffffffffffffffffffffffffff168673ffffffffffffffffffffffffffffffffffffffff16141515156111d157600080fd5b600960008873ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002054851115151561121f57600080fd5b600a60008873ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020016000205485111515156112aa57600080fd5b6112fc85600960008a73ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002054612e1290919063ffffffff16565b600960008973ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020016000208190555061139185600960008973ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002054612e2b90919063ffffffff16565b600960008873ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020016000208190555061146385600a60008a73ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002054612e1290919063ffffffff16565b600a60008973ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020819055508573ffffffffffffffffffffffffffffffffffffffff168773ffffffffffffffffffffffffffffffffffffffff167fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef876040518082815260200191505060405180910390a3600193505050509392505050565b6000600860009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff161415156115b457600080fd5b6000600c60008473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060006101000a81548160ff0219169083151502179055506000600d60008473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020819055508173ffffffffffffffffffffffffffffffffffffffff167fe94479a9f7e1952cc78f2d6baab678adc1b772d936c6583def489e524cb6669260405160405180910390a260019050919050565b600660009054906101000a900460ff1681565b600860149054906101000a900460ff161515156116cc57600080fd5b600073ffffffffffffffffffffffffffffffffffffffff168473ffffffffffffffffffffffffffffffffffffffff161415151561170857600080fd5b600073ffffffffffffffffffffffffffffffffffffffff168373ffffffffffffffffffffffffffffffffffffffff161415151561174457600080fd5b600073ffffffffffffffffffffffffffffffffffffffff168273ffffffffffffffffffffffffffffffffffffffff161415151561178057600080fd5b600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16141515156117bc57600080fd5b87600490805190602001906117d2929190612e8a565b5086600590805190602001906117e9929190612e8a565b508560079080519060200190611800929190612e8a565b5084600660006101000a81548160ff021916908360ff16021790555083600860006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff16021790555082600160006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff16021790555081600260006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055506118e881612e47565b6001600860146101000a81548160ff0219169083151502179055505050505050505050565b600860009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1681565b600160009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff1614151561198f57600080fd5b6000600160146101000a81548160ff0219169083151502179055507f7805862f689e2f13df9f062ff482ad3ad112aca9e0847911ed832e158c525b3360405160405180910390a1565b600080600160149054906101000a900460ff161515156119f757600080fd5b60011515600c60003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060009054906101000a900460ff161515141515611a5657600080fd5b3360001515600360008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060009054906101000a900460ff161515141515611ab657600080fd5b8460001515600360008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060009054906101000a900460ff161515141515611b1657600080fd5b600073ffffffffffffffffffffffffffffffffffffffff168673ffffffffffffffffffffffffffffffffffffffff1614151515611b5257600080fd5b600085111515611b6157600080fd5b600d60003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020549250828511151515611bb257600080fd5b611bc785600b54612e2b90919063ffffffff16565b600b81905550611c1f85600960008973ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002054612e2b90919063ffffffff16565b600960008873ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002081905550611c758584612e1290919063ffffffff16565b600d60003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020819055508573ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff167fab8530f87dc9b59234c4623bf917212bb2536d647574c8e7e5da92c2ede0c9f8876040518082815260200191505060405180910390a38573ffffffffffffffffffffffffffffffffffffffff1660007fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef876040518082815260200191505060405180910390a36001935050505092915050565b6000600160149054906101000a900460ff16151515611d9857600080fd5b60011515600c60003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060009054906101000a900460ff161515141515611df757600080fd5b3360001515600360008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060009054906101000a900460ff161515141515611e5757600080fd5b600960003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020549150600083111515611ea857600080fd5b828210151515611eb757600080fd5b611ecc83600b54612e1290919063ffffffff16565b600b81905550611ee58383612e1290919063ffffffff16565b600960003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020819055503373ffffffffffffffffffffffffffffffffffffffff167fcc16f5dbb4873280815c1ee09dbd06736cffcc184412cf7a71a0fdb75d397ca5846040518082815260200191505060405180910390a2600073ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff167fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef856040518082815260200191505060405180910390a3505050565b6000600160149054906101000a900460ff16151515611fff57600080fd5b600860009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff1614151561205b57600080fd5b6001600c60008573ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060006101000a81548160ff02191690831515021790555081600d60008573ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020819055508273ffffffffffffffffffffffffffffffffffffffff167f46980fca912ef9bcdbd36877427b6b90e860769f604e89c0e67720cece530d20836040518082815260200191505060405180910390a26001905092915050565b6121576123be565b73ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff1614151561219057600080fd5b600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16141515156121cc57600080fd5b80600160006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff160217905550600160009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff167fb80482a293ca2e013eda8683c9bd7fc8347cfdaeea5ede58cba46df502c2a60460405160405180910390a250565b600160149054906101000a900460ff1681565b6000600960008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020549050919050565b600160009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff1614151561232d57600080fd5b60018060146101000a81548160ff0219169083151502179055507f6985a02210a168e66602d3235cb6db0e70f92b3ba4d376a33c0f3d9434bff62560405160405180910390a1565b6000600d60008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020549050919050565b60008060009054906101000a900473ffffffffffffffffffffffffffffffffffffffff16905090565b60058054600181600116156101000203166002900480601f01602080910402602001604051908101604052809291908181526020018280546001816001161561010002031660029004801561247d5780601f106124525761010080835404028352916020019161247d565b820191906000526020600020905b81548152906001019060200180831161246057829003601f168201915b505050505081565b600160009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1681565b6000600160149054906101000a900460ff161515156124c957600080fd5b3360001515600360008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060009054906101000a900460ff16151514151561252957600080fd5b8360001515600360008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060009054906101000a900460ff16151514151561258957600080fd5b600073ffffffffffffffffffffffffffffffffffffffff168573ffffffffffffffffffffffffffffffffffffffff16141515156125c557600080fd5b600960003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002054841115151561261357600080fd5b61266584600960003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002054612e1290919063ffffffff16565b600960003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020819055506126fa84600960008873ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002054612e2b90919063ffffffff16565b600960008773ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020819055508473ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff167fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef866040518082815260200191505060405180910390a360019250505092915050565b6127b66123be565b73ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff161415156127ef57600080fd5b600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff161415151561282b57600080fd5b80600860006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff160217905550600860009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff167fdb66dfa9c6b8f5226fe9aac7e51897ae8ee94ac31dc70bb6c9900b2574b707e660405160405180910390a250565b6000600c60008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060009054906101000a900460ff169050919050565b6129326123be565b73ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff1614151561296b57600080fd5b600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff16141515156129a757600080fd5b80600260006101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff160217905550600260009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff167fc67398012c111ce95ecb7429b933096c977380ee6c421175a71a4a4c6c88c06e60405160405180910390a250565b600260009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1681565b6000600a60008473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002054905092915050565b60078054600181600116156101000203166002900480601f016020809104026020016040519081016040528092919081815260200182805460018160011615610100020316600290048015612b935780601f10612b6857610100808354040283529160200191612b93565b820191906000526020600020905b815481529060010190602001808311612b7657829003601f168201915b505050505081565b612ba36123be565b73ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff16141515612bdc57600080fd5b600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614151515612c1857600080fd5b7f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0612c416123be565b82604051808373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020018273ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019250505060405180910390a1612cbf81612e47565b50565b600260009054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff16141515612d1e57600080fd5b6001600360008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060006101000a81548160ff0219169083151502179055508073ffffffffffffffffffffffffffffffffffffffff167fffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b85560405160405180910390a250565b6000600360008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060009054906101000a900460ff169050919050565b6000828211151515612e2057fe5b818303905092915050565b60008183019050828110151515612e3e57fe5b80905092915050565b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff16021790555050565b828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f10612ecb57805160ff1916838001178555612ef9565b82800160010185558215612ef9579182015b82811115612ef8578251825591602001919060010190612edd565b5b509050612f069190612f0a565b5090565b612f2c91905b80821115612f28576000816000905550600101612f10565b5090565b905600a165627a7a723058206e88309bb38ccbd9bd656057426ebeeeb874e7c4fa16a1545a2674f6df2b7d430029'

const main = async () => {
  const evm = await createEVM()

  // 계정 설정
  const contractProxyAddr = new Address(hexToBytes('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'))
  const contractAddr = new Address(hexToBytes('0x0882477e7895bdC5cea7cB1552ed914aB157Fe56'))
  const sender = new Address(hexToBytes('0xE86Cf48dc0452abB479A232dDF11793Fb199F034'))

  // 컨트랙트 계정 생성
    await evm.stateManager.putAccount(contractProxyAddr, new Account())
    await evm.stateManager.putAccount(contractAddr, new Account())

  // 컨트랙트 코드 배포
  await evm.stateManager.putCode(contractProxyAddr, hexToBytes(contractProxyCode))
  await evm.stateManager.putCode(contractProxyAddr, hexToBytes(contractCode))

  // 잔액 설정
  const balanceSlot = '0x5'
  const senderBalanceSlot = keccak256(
    hexToBytes(
      '0x' + sender.toString().slice(2).padStart(64, '0') + balanceSlot.slice(2).padStart(64, '0'),
    ),
  )
  await evm.stateManager.putStorage(
    contractProxyAddr,
    senderBalanceSlot,
    hexToBytes('0x' + '0ba43b7400'.padStart(64, '0')),
  )
    

  // Now run the transfer
  const result = await evm.runCode({
    caller: sender,
    to: contractProxyAddr,
    code: hexToBytes(contractProxyCode),
    data: hexToBytes(
      "0xa9059cbb0000000000000000000000009944a69089a39cb719b8533cc892e133e3a80a0700000000000000000000000000000000000000000000000000000001e88db3d7"
    ),
  })

  console.log("result", result)

   // Get circuit placements
  console.log('Circuit Placements:', 
    JSON.stringify(result.runState?.synthesizer.placements, null, 2)
  )

  // Generate proof
  const permutation = await finalize(result.runState!.synthesizer.placements, true)
}

void main()
