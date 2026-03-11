/**
 * x402-signer.js — Adapter layer between @emblemvault/auth-sdk signers and @x402 SDK signer interfaces.
 *
 * EVM:  auth-sdk toViemAccount() → ClientEvmSigner (direct pass-through since auth-sdk@2.3.18)
 *
 * SVM:  auth-sdk toSolanaWeb3Signer() → @solana/kit TransactionSigner
 *       Bridges auth-sdk's signTransaction (web3.js v1) to @solana/kit's signTransactions interface.
 */

/**
 * Narrow an unknown SDK response to Uint8Array.
 *
 * @param {unknown} value
 * @param {string} methodName
 * @returns {Uint8Array}
 */
function expectUint8Array(value, methodName) {
  if (value instanceof Uint8Array) {
    return value;
  }
  throw new TypeError(`${methodName} returned a non-binary value`);
}

/**
 * Brand a 64-byte signature for @solana/signers types.
 *
 * @param {Uint8Array} value
 * @returns {import('@solana/keys').SignatureBytes}
 */
function toSignatureBytes(value) {
  if (value.length !== 64) {
    throw new TypeError(`Expected 64 signature bytes, received ${value.length}`);
  }
  return /** @type {import('@solana/keys').SignatureBytes} */ (value);
}

/**
 * Build a SignatureDictionary keyed by the signer's branded Solana address.
 *
 * @param {import('@solana/addresses').Address} address
 * @param {import('@solana/keys').SignatureBytes} signature
 * @returns {import('@solana/signers').SignatureDictionary}
 */
function createSignatureDictionary(address, signature) {
  return /** @type {import('@solana/signers').SignatureDictionary} */ ({ [address]: signature });
}

/**
 * Create an EVM signer for x402 payments from auth-sdk.
 *
 * @param {import('@emblemvault/auth-sdk').EmblemAuthSDK} authSdk
 * @returns {Promise<import('@x402/evm').ClientEvmSigner>}
 */
export async function createEvmSigner(authSdk) {
  return authSdk.toViemAccount();
}

/**
 * Create an SVM signer for x402 payments from auth-sdk.
 * Bridges auth-sdk's Solana signer to @solana/kit's TransactionSigner interface.
 *
 * Uses auth-sdk's signTransaction (which calls /sign-solana-transaction) for transaction signing.
 * The server-side Lit Action is patched to return the correct signer index.
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

  const solanaSigner = await authSdk.toSolanaWeb3Signer();

  /** @type {import('@x402/svm').ClientSvmSigner & import('@solana/signers').MessagePartialSigner} */
  const signer = {
    address: solAddr,

    // Some @x402/svm runtime paths adapt client signers through a message-signing interface.
    async signMessages(messages) {
      /** @type {import('@solana/signers').SignatureDictionary[]} */
      const results = [];
      for (const msg of messages) {
        const bytes = msg.content instanceof Uint8Array ? msg.content : new Uint8Array(msg.content);
        const sig = toSignatureBytes(await solanaSigner.signMessage(bytes));
        results.push(createSignatureDictionary(solAddr, sig));
      }
      return results;
    },

    // TransactionPartialSigner: sign compiled transactions via auth-sdk.
    // Converts @solana/kit compiled transaction → Solana wire format → auth-sdk signTransaction.
    // Returns SignatureDictionary[] — plain objects { [address]: SignatureBytes }
    async signTransactions(transactions) {
      /** @type {import('@solana/signers').SignatureDictionary[]} */
      const results = [];
      for (const tx of transactions) {
        const messageBytes = tx.messageBytes instanceof Uint8Array
          ? tx.messageBytes
          : new Uint8Array(tx.messageBytes);

        // Parse numRequiredSignatures from the compiled message header.
        // v0 messages: byte 0 = 0x80 (version prefix), byte 1 = numRequiredSignatures
        const isVersioned = (messageBytes[0] & 0x80) !== 0;
        const numSigners = isVersioned ? messageBytes[1] : messageBytes[0];

        // Build Solana wire format: [compact-u16: numSigners] [N × 64-byte zeros] [messageBytes]
        const sigSectionLen = numSigners * 64;
        const wire = new Uint8Array(1 + sigSectionLen + messageBytes.length);
        wire[0] = numSigners;
        wire.set(messageBytes, 1 + sigSectionLen);

        // Base64 encode — auth-sdk's signTransaction accepts base64 strings
        const b64Wire = Buffer.from(wire).toString('base64');

        // Sign via auth-sdk (calls /sign-solana-transaction internally)
        const signedBytes = expectUint8Array(
          await solanaSigner.signTransaction(b64Wire),
          'solanaSigner.signTransaction',
        );

        // signedBytes is a Uint8Array of the full signed wire format.
        // Extract our signature from the signature slots.
        let ourSig = null;
        for (let i = 0; i < numSigners; i++) {
          const start = 1 + i * 64;
          const slot = signedBytes.slice(start, start + 64);
          if (slot.some(b => b !== 0)) {
            ourSig = new Uint8Array(slot);
            break;
          }
        }

        if (!ourSig) {
          throw new Error('signTransaction returned no valid signature in signed transaction');
        }

        results.push(createSignatureDictionary(solAddr, toSignatureBytes(ourSig)));
      }
      return results;
    },
  };

  return signer;
}
