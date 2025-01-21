import axios from 'axios';

const ETHERSCAN_API_URL = 'https://api.etherscan.io/api';
const API_KEY = import.meta.env.VITE_ETHERSCAN_API_KEY;

export const fetchTransactionBytecode = async (transactionId: string): Promise<string> => {
  const response = await axios.get(ETHERSCAN_API_URL, {
    params: {
      module: 'proxy',
      action: 'eth_getTransactionByHash',
      txhash: transactionId,
      apikey: API_KEY,
    },
  });

  if (!response.data || !response.data.result || !response.data.result.input) {
    throw new Error('Transaction bytecode not found.');
  }

  return response.data.result.input; // Bytecode is in the input
};
