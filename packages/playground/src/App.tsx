import React, { useState, useEffect } from 'react';
import { fetchTransactionBytecode } from '../utils/etherscanApi';
import { Buffer } from 'buffer';
import { createEVM } from '../../frontend/synthesizer/src/constructors';
import { hexToBytes } from '../../frontend/synthesizer/libs/util/dist/esm/index.js';
import { Address } from '../../frontend/synthesizer/libs/util/dist/esm/index.js';
import { formatLogsStructured, FormattedLog } from '../utils/formatLog';
import { TON_CONTRACT_CODE } from './constant/evm.js';
import { setupEVM } from '../utils/setupEVM';
import logo from '/Primary_Black.png';
import downloadIcon from '/download.svg';
import './App.css';

window.Buffer = window.Buffer || Buffer;

function serializePlacements(placements: any) {
    const convertValue = (val: any): any => {
        if (typeof val === 'bigint') {
            return val.toString();
        }
        if (Array.isArray(val)) {
            return val.map(convertValue);
        }
        if (typeof val === 'object' && val !== null) {
            return Object.fromEntries(
                Object.entries(val).map(([k, v]) => [k, convertValue(v)])
            );
        }
        return val;
    };
    return JSON.stringify({ placements: convertValue(placements) });
}

const App: React.FC = () => {
    const [transactionId, setTransactionId] = useState('');
    const [status, setStatus] = useState<string | null>(null);
    const [serverData, setServerData] = useState<{ permutation: string | null; placementInstance: string | null } | null>(null);
    const [logs, setLogs] = useState<FormattedLog[] | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);

    const processTransaction = async (txId: string) => {
        try {
            setIsProcessing(true);
            setStatus('Fetching bytecode from Etherscan...');
            setLogs(null);
            setServerData(null);

            const { bytecode, from, to } = await fetchTransactionBytecode(txId);
            if (!bytecode || bytecode.length < 2) {
                throw new Error('Invalid bytecode received. Check your transaction ID.');
            }

            const contractCode = TON_CONTRACT_CODE;
            setStatus('Creating and running the EVM...');
            const evm = await createEVM();
            const contractAddr = new Address(hexToBytes(to));
            const sender = new Address(hexToBytes(from));
            await setupEVM(evm, from, contractCode, contractAddr, sender);

            const res = await evm.runCode({
                caller: sender,
                to: contractAddr,
                code: contractCode,
                data: hexToBytes(bytecode),
            });

            if (res.logs) {
                const formattedLogs = formatLogsStructured(res.logs);
                setLogs(formattedLogs);
            }

            console.log(res)

            if (!res.runState?.synthesizer?.placements) {
                throw new Error('No placements generated by the synthesizer.');
            }

            const rawMap = res.runState.synthesizer.placements;
            const placementsObj = Object.fromEntries(rawMap.entries());

            setStatus('Finalizing placements on the server...');
            const response = await fetch('api/finalize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: serializePlacements(placementsObj),
            });

            if (!response.ok) {
                throw new Error(`Server returned status ${response.status}`);
            }

            const json = await response.json();
            if (!json.ok) {
                throw new Error(json.error || 'Unknown server error.');
            }

            const { permutation, placementInstance } = json.data || {};
            setServerData({ permutation, placementInstance });
            setStatus(null);
            sessionStorage.removeItem('pendingTransactionId');

        } catch (error) {
            console.error('Error:', error);
            setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
            sessionStorage.removeItem('pendingTransactionId');
        } finally {
            setIsProcessing(false);
        }
    };

    const handleSubmit = () => {
        if (isProcessing) return;
        sessionStorage.setItem('pendingTransactionId', transactionId);
        window.location.reload();
    };

    useEffect(() => {
        const pendingTxId = sessionStorage.getItem('pendingTransactionId');
        if (pendingTxId) {
            setTransactionId(pendingTxId);
            processTransaction(pendingTxId);
        }
    }, []);

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
        <div className="container">
          <div className="logo-container">
            <img src={logo} alt="Synthesizer Logo" className="logo-image" />
          </div>
            <div className="title-container">
                <h1 className="main-title">Synthesizer</h1>
                <h2 className="subtitle">Developer Playground</h2>
            </div>
            <input
                type="text"
                value={transactionId}
                onChange={(e) => setTransactionId(e.target.value)}
                placeholder="Enter Transaction ID"
                className="transaction-input"
                disabled={isProcessing}
            />
            <button
                onClick={handleSubmit}
                className={`btn btn-process ${isProcessing ? 'disabled' : ''}`}
                disabled={isProcessing}
            >
                {isProcessing ? 'Processing...' : 'Process'}
            </button>

            {logs?.map((log, index) => (
                <div key={index} className="log-entry">
                    <div className="log-field">
                        <strong>Token Address:</strong> {log.address}
                    </div>
                    <div className="log-field">
                        <strong>Topics:</strong>
                        <div className="log-topics">
                            <div><strong>Signature:</strong> {log.topics.signature}</div>
                            <div><strong>From:</strong> {log.topics.from}</div>
                            <div><strong>To:</strong> {log.topics.to}</div>
                        </div>
                    </div>
                    <div className="log-field">
                        <strong>Data:</strong>
                        <div className="log-data" title={`Hex: ${log.data.hex}\nValue: ${log.data.value}`}>
                            <div><strong>Hex:</strong> {log.data.hex}</div>
                            <div><strong>Value:</strong> {log.data.value}</div>
                        </div>
                    </div>
                </div>
            ))}

            <div className="status-download-container">
              {status && !status.startsWith('Error') ? (
                  <div className="loading-spinner-container">
                      <div className="loading-spinner"></div>
                  </div>
              ) : status ? (
                  <div className="status-message error">
                      <div className="error-content">
                          {status.replace('Error: ', '')}
                      </div>
                  </div>
              ) : null}
                {serverData?.permutation && (
                    <button
                        onClick={() => handleDownload(serverData.permutation, 'permutation.json')}
                        className="btn btn-download btn-permutation"
                        disabled={isProcessing}
                    >
                        <img src={downloadIcon} alt="download" className="download-icon" />
                        Permutation
                    </button>
                )}
                {serverData?.placementInstance && (
                    <button
                        onClick={() => handleDownload(serverData.placementInstance, 'placementInstance.json')}
                        className="btn btn-download btn-placement"
                        disabled={isProcessing}
                    >
                        <img src={downloadIcon} alt="download" className="download-icon" />
                        Placement Instance
                    </button>
                )}
            </div>
        </div>
    );
};

export default App;