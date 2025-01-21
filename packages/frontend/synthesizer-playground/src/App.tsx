import React, { useState } from 'react';
import { fetchTransactionBytecode } from '../utils/etherscanApi';
import { Buffer } from 'buffer';

window.Buffer = window.Buffer || Buffer;

// Mock EVM and finalization logic
const mockEVM = {
  runCode: async ({ code, gasLimit }: { code: Uint8Array; gasLimit: bigint }) => {
    console.log('Mock EVM runCode called with:', { code, gasLimit });
    return {
      runState: {
        synthesizer: {
          placements: new Map(),
        },
      },
    };
  },
};

const mockFinalize = async (placements: Map<any, any>, validate: boolean) => {
  console.log('Mock finalize called with:', { placements, validate });
  return { message: 'Finalized mock placements' };
};

const App: React.FC = () => {
  const [transactionId, setTransactionId] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);

  const handleSubmit = async () => {
    try {
      if (!transactionId) {
        setStatus('Please enter a valid Transaction ID.');
        return;
      }

      setStatus('Fetching transaction bytecode...');
      const bytecode = await fetchTransactionBytecode(transactionId);

      setStatus('Running EVM code...');
      const res = await mockEVM.runCode({
        code: Uint8Array.from(Buffer.from(bytecode.slice(2), 'hex')),
        gasLimit: BigInt(0xffff),
      });

      setStatus('Finalizing placements...');
      const finalizedPlacements = await mockFinalize(res.runState!.synthesizer.placements, true);

      setStatus('Process complete!');
      setOutput(JSON.stringify(finalizedPlacements, null, 2));
    } catch (error) {
      console.error('Error:', error);
      setStatus('Error processing the transaction.');
      setOutput('Error processing transaction');
    }
  };

  return (
    <div style={{ padding: '20px' }}>
      <h1>Synthesizer Developer Playground</h1>
      <input
        type="text"
        value={transactionId}
        onChange={(e) => setTransactionId(e.target.value)}
        placeholder="Enter Transaction ID"
        style={{
          padding: '10px',
          width: '300px',
          marginRight: '10px',
          border: '1px solid #ccc',
          borderRadius: '4px',
        }}
      />
      <button
        onClick={handleSubmit}
        style={{
          padding: '10px 20px',
          background: '#007bff',
          color: '#fff',
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer',
        }}
      >
        Process
      </button>
      <div style={{ marginTop: '20px' }}>
        {status && <p>{status}</p>}
        {output && <pre>{output}</pre>}
      </div>
    </div>
  );
};

export default App;
