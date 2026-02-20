/**
 * x402-signer.js — Adapter layer between @emblemvault/auth-sdk signers and @x402 SDK signer interfaces.
 *
 * EVM:  auth-sdk toViemAccount() → ClientEvmSigner (direct match)
 * SVM:  auth-sdk toSolanaWeb3Signer() → ClientSvmSigner (TransactionSigner from @solana/kit, needs adapter)
 */

/**
 * Create an EVM signer for x402 payments from auth-sdk.
 * auth-sdk's toViemAccount() directly satisfies ClientEvmSigner:
 *   { address: `0x${string}`, signTypedData({ domain, types, primaryType, message }) }
 *
 * @param {import('@emblemvault/auth-sdk').EmblemAuthSDK} authSdk
 * @returns {Promise<import('@x402/evm').ClientEvmSigner>}
 */
export async function createEvmSigner(authSdk) {
  const viemAccount = await authSdk.toViemAccount();
  return viemAccount;
}

/**
 * Create an SVM signer for x402 payments from auth-sdk.
 * Bridges auth-sdk's @solana/web3.js v1 signer to @solana/kit TransactionSigner.
 *
 * @param {import('@emblemvault/auth-sdk').EmblemAuthSDK} authSdk
 * @returns {Promise<import('@x402/svm').ClientSvmSigner>}
 */
export async function createSvmSigner(authSdk) {
  const { address: createAddress } = await import('@solana/kit');
  const vaultInfo = await authSdk.getVaultInfo();
  const solanaAddr = vaultInfo.solanaAddress || vaultInfo.address;
  if (!solanaAddr) throw new Error('No Solana address found in vault info');
  const solAddr = createAddress(solanaAddr);
  const web3Signer = await authSdk.toSolanaWeb3Signer();

  // Build @solana/kit compatible TransactionSigner + MessagePartialSigner
  return {
    address: solAddr,

    // MessagePartialSigner: sign raw message bytes
    async signMessages(messages) {
      const results = [];
      for (const msg of messages) {
        const sig = await web3Signer.signMessage(new Uint8Array(msg));
        const sigMap = new Map();
        sigMap.set(solAddr, sig);
        results.push(sigMap);
      }
      return results;
    },

    // TransactionPartialSigner: sign compiled transactions
    async signTransactions(transactions) {
      const results = [];
      for (const tx of transactions) {
        const signed = await web3Signer.signTransaction(tx);
        results.push(signed);
      }
      return results;
    },
  };
}
