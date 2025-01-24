import React, { useState } from 'react';
import { fetchTransactionBytecode } from '../utils/etherscanApi';
import { Buffer } from 'buffer';
import { createEVM } from '../../frontend/synthesizer/src/constructors';

window.Buffer = window.Buffer || Buffer;

const App: React.FC = () => {
  const [transactionId, setTransactionId] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [serverData, setServerData] = useState<{ permutation: string | null; placementInstance: string | null } | null>(null);

  const handleSubmit = async () => {
    try {
      setStatus('Fetching bytecode from Etherscan...');
      setServerData(null);

      // 1) Fetch the bytecode
      const bytecode = await fetchTransactionBytecode(transactionId);
      if (!bytecode || bytecode.length < 2) {
        throw new Error('Invalid bytecode received. Check your transaction ID.');
      }

      // 2) Run the EVM
      setStatus('Creating and running the EVM...');
      const evm = await createEVM();
      const res = await evm.runCode({
        code: Uint8Array.from(Buffer.from(bytecode.slice(2), 'hex')),
        gasLimit: BigInt(0xffff),
      });

      if (!res.runState?.synthesizer?.placements) {
        throw new Error('No placements generated by the synthesizer.');
      }

      // Convert placements to a plain object
      const rawMap = res.runState.synthesizer.placements;
      const placementsObj = Object.fromEntries(rawMap.entries());

      // 3) Send placements to the server
      setStatus('Finalizing placements on the server...');
      const response = await fetch('api/finalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ placements: placementsObj }),
      });

      if (!response.ok) {
        throw new Error(`Server returned status ${response.status}`);
      }

      const json = await response.json();
      if (!json.ok) {
        throw new Error(json.error || 'Unknown server error.');
      }

      // Extract server response
      const { permutation, placementInstance } = json.data || {};
      setServerData({ permutation, placementInstance });
      setStatus('Process complete! Files are ready for download.');
    } catch (error) {
      console.error('Error:', error);
      setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
      setServerData(null);
    }
  };

  // Handle file download
  const handleDownload = (fileContent: string | null, fileName: string) => {
    if (!fileContent) return;
    const blob = new Blob([fileContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
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
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer',
        }}
      >
        Process
      </button>
      <div style={{ marginTop: '20px' }}>
        {status && <p>{status}</p>}
        {serverData?.permutation && (
          <button
            onClick={() => handleDownload(serverData.permutation, 'permutation.ts')}
            style={{
              padding: '10px 20px',
              background: '#28a745',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              marginRight: '10px',
            }}
          >
            Download Permutation
          </button>
        )}
        {serverData?.placementInstance && (
          <button
            onClick={() => handleDownload(serverData.placementInstance, 'placementInstance.ts')}
            style={{
              padding: '10px 20px',
              background: '#17a2b8',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Download Placement Instance
          </button>
        )}
      </div>
    </div>
  );
};

export default App;
