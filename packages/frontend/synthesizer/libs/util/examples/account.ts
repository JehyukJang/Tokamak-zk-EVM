<<<<<<< HEAD
import { createAccount } from "@ethereumjs/util/index.js"

const account = createAccount({
  nonce: '0x02',
  balance: '0x0384',
  storageRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
  codeHash: '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
})
console.log(`Account with nonce=${account.nonce} and balance=${account.balance} created`)
=======
import { createAccount } from "@synthesizer-libs/util"

const account = createAccount({
  nonce: '0x02',
  balance: '0x0384',
  storageRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
  codeHash: '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
})
console.log(`Account with nonce=${account.nonce} and balance=${account.balance} created`)
>>>>>>> 603bf51d9e02a58183fabb7f7fd08e9580ceef44
