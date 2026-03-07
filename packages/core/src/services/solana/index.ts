/**
 * Solana Service - Token gating, NFT minting, and wallet operations
 */
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getAccount,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import type { SolanaService, SolanaConfig, NFTMetadata } from '../../types/index.js';

export class SwarmSolanaService implements SolanaService {
  private connection: Connection;
  private wallet: Keypair | null = null;

  constructor(
    private readonly config: SolanaConfig,
    walletSecret?: string
  ) {
    this.connection = new Connection(config.rpcUrl, 'confirmed');
    
    if (walletSecret) {
      try {
        const secretKey = JSON.parse(walletSecret);
        this.wallet = Keypair.fromSecretKey(new Uint8Array(secretKey));
      } catch (error) {
        console.error('Failed to parse wallet secret:', error instanceof Error ? error.message : String(error));
      }
    }
  }

  /**
   * Get SOL or SPL token balance for a wallet
   */
  async getBalance(walletAddress: string, tokenMint?: string): Promise<number> {
    try {
      const publicKey = new PublicKey(walletAddress);

      if (!tokenMint) {
        // Get SOL balance
        const balance = await this.connection.getBalance(publicKey);
        return balance / LAMPORTS_PER_SOL;
      }

      // Get SPL token balance
      const mintPublicKey = new PublicKey(tokenMint);
      const tokenAccount = await getAssociatedTokenAddress(
        mintPublicKey,
        publicKey
      );

      try {
        const account = await getAccount(this.connection, tokenAccount);
        // Convert to human-readable based on decimals (assuming 9 for most tokens)
        return Number(account.amount) / 1e9;
      } catch (innerError) {
        const innerMsg = innerError instanceof Error ? innerError.message : String(innerError);
        if (innerMsg.includes('could not find mint')) {
          console.warn(JSON.stringify({
            event: 'wallet_balance_mint_not_found',
            mint: tokenMint,
            wallet: walletAddress,
          }));
        }
        // Token account doesn't exist
        return 0;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('could not find mint') && tokenMint) {
        console.warn(JSON.stringify({
          event: 'wallet_balance_mint_not_found',
          mint: tokenMint,
          wallet: walletAddress,
        }));
      }
      console.error('Failed to get balance:', msg);
      return 0;
    }
  }

  /**
   * Verify that a wallet holds a minimum token balance
   */
  async verifyTokenHolder(
    walletAddress: string,
    tokenMint: string,
    minBalance: number
  ): Promise<boolean> {
    const balance = await this.getBalance(walletAddress, tokenMint);
    return balance >= minBalance;
  }

  /**
   * Transfer SOL or SPL tokens from bot wallet
   */
  async transfer(to: string, amount: number, tokenMint?: string): Promise<string> {
    if (!this.wallet) {
      throw new Error('Wallet not configured');
    }

    const toPublicKey = new PublicKey(to);

    if (!tokenMint) {
      // Transfer SOL
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: this.wallet.publicKey,
          toPubkey: toPublicKey,
          lamports: amount * LAMPORTS_PER_SOL,
        })
      );

      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [this.wallet]
      );

      return signature;
    }

    // Transfer SPL token
    const mintPublicKey = new PublicKey(tokenMint);
    
    const fromTokenAccount = await getAssociatedTokenAddress(
      mintPublicKey,
      this.wallet.publicKey
    );
    
    const toTokenAccount = await getAssociatedTokenAddress(
      mintPublicKey,
      toPublicKey
    );

    const transaction = new Transaction().add(
      createTransferInstruction(
        fromTokenAccount,
        toTokenAccount,
        this.wallet.publicKey,
        BigInt(amount * 1e9), // Assuming 9 decimals
        [],
        TOKEN_PROGRAM_ID
      )
    );

    const signature = await sendAndConfirmTransaction(
      this.connection,
      transaction,
      [this.wallet]
    );

    return signature;
  }

  /**
   * Mint an NFT (placeholder - needs Metaplex integration)
   */
  async mintNFT(metadata: NFTMetadata, recipient: string): Promise<string> {
    // This is a placeholder implementation
    // Full implementation requires Metaplex SDK
    // npm install @metaplex-foundation/js
    
    console.log('Minting NFT:', {
      metadata,
      recipient,
      network: this.config.network,
    });

    // For production, implement using Metaplex:
    // import { Metaplex, keypairIdentity } from '@metaplex-foundation/js';
    // const metaplex = Metaplex.make(this.connection).use(keypairIdentity(this.wallet));
    // const { nft } = await metaplex.nfts().create({ ... });
    
    throw new Error('NFT minting not yet implemented - requires Metaplex integration');
  }

  /**
   * Verify a wallet signature for authentication
   */
  async verifySignature(
    walletAddress: string,
    message: string,
    signature: string
  ): Promise<boolean> {
    try {
      const nacl = await import('tweetnacl');
      
      const publicKey = new PublicKey(walletAddress);
      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = Buffer.from(signature, 'base64');

      return nacl.sign.detached.verify(
        messageBytes,
        signatureBytes,
        publicKey.toBytes()
      );
    } catch (error) {
      console.error('Signature verification failed:', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * Get wallet public key
   */
  getWalletAddress(): string | null {
    return this.wallet?.publicKey.toBase58() || null;
  }

  /**
   * Check if service is properly configured
   */
  isConfigured(): boolean {
    return this.config.enabled && !!this.wallet;
  }
}

/**
 * Factory function
 */
export function createSolanaService(
  config: SolanaConfig,
  walletSecret?: string
): SolanaService {
  return new SwarmSolanaService(config, walletSecret);
}
