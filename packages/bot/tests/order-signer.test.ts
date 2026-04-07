// Order Signer Tests
// Tests for EIP-712 signing functionality

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signTypedData, SignTypedDataVersion } from '@metamask/eth-sig-util';

// Mock the metamask util
vi.mock('@metamask/eth-sig-util', () => ({
  signTypedData: vi.fn(),
  SignTypedDataVersion: {
    V4: 'V4'
  }
}));

// Import after mocking
const { signOrder } = await import('../src/api/order-signer.js');

describe('Order Signer', () => {
  const mockPrivateKey = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GRVT_PRIVATE_KEY = mockPrivateKey;
    process.env.GRVT_SUB_ACCOUNT_ID = '1';
  });

  describe('signOrder', () => {
    it('should generate valid EIP-712 signature structure', async () => {
      const mockSignature = '0xabcdef123456789...'; // 132 char signature
      (signTypedData as any).mockReturnValue(mockSignature);

      const orderParams = {
        instrument: 'ETH_USDT_Perp',
        side: 'buy' as const,
        quantity: 0.02,
        price: 2000.0,
        postOnly: true
      };

      const result = await signOrder(orderParams);

      expect(result).toHaveProperty('order');
      expect(result).toHaveProperty('signature');
      expect(result.signature).toBe(mockSignature);
    });

    it('should use correct PRICE_MULTIPLIER of 1e9', async () => {
      const mockSignature = '0xtest';
      (signTypedData as any).mockReturnValue(mockSignature);

      const orderParams = {
        instrument: 'ETH_USDT_Perp',
        side: 'buy' as const,
        quantity: 0.02,
        price: 2000.0,
        postOnly: true
      };

      await signOrder(orderParams);

      // Check the typed data passed to signTypedData
      const [{ data }] = (signTypedData as any).mock.calls[0];
      const orderLeg = data.message.legs[0];

      // Price should be multiplied by 1e9
      expect(orderLeg.limitPrice).toBe('2000000000000'); // 2000 * 1e9
    });

    it('should use correct EIP-712 domain', async () => {
      const mockSignature = '0xtest';
      (signTypedData as any).mockReturnValue(mockSignature);

      const orderParams = {
        instrument: 'ETH_USDT_Perp',
        side: 'buy' as const,
        quantity: 0.02,
        price: 2000.0,
        postOnly: true
      };

      await signOrder(orderParams);

      const [{ data }] = (signTypedData as any).mock.calls[0];

      expect(data.domain).toEqual({
        name: 'GRVT Exchange',
        version: '0',
        chainId: 325
      });
    });

    it('should use correct asset ID for ETH_USDT_Perp', async () => {
      const mockSignature = '0xtest';
      (signTypedData as any).mockReturnValue(mockSignature);

      const orderParams = {
        instrument: 'ETH_USDT_Perp',
        side: 'buy' as const,
        quantity: 0.02,
        price: 2000.0,
        postOnly: true
      };

      await signOrder(orderParams);

      const [{ data }] = (signTypedData as any).mock.calls[0];
      const orderLeg = data.message.legs[0];

      expect(orderLeg.assetID).toBe('0x030401'); // ETH_USDT_Perp asset ID
    });

    it('should calculate contract size using base decimals', async () => {
      const mockSignature = '0xtest';
      (signTypedData as any).mockReturnValue(mockSignature);

      const orderParams = {
        instrument: 'ETH_USDT_Perp',
        side: 'buy' as const,
        quantity: 0.02,
        price: 2000.0,
        postOnly: true
      };

      await signOrder(orderParams);

      const [{ data }] = (signTypedData as any).mock.calls[0];
      const orderLeg = data.message.legs[0];

      // Contract size = quantity * 10^base_decimals = 0.02 * 10^9 = 20000000
      expect(orderLeg.contractSize).toBe('20000000');
    });

    it('should set correct buy/sell direction', async () => {
      const mockSignature = '0xtest';
      (signTypedData as any).mockReturnValue(mockSignature);

      // Test buy order
      const buyParams = {
        instrument: 'ETH_USDT_Perp',
        side: 'buy' as const,
        quantity: 0.02,
        price: 2000.0,
        postOnly: true
      };

      await signOrder(buyParams);
      const [{ data: buyData }] = (signTypedData as any).mock.calls[0];
      expect(buyData.message.legs[0].isBuyingContract).toBe(true);

      // Test sell order
      const sellParams = {
        instrument: 'ETH_USDT_Perp',
        side: 'sell' as const,
        quantity: 0.02,
        price: 2000.0,
        postOnly: true
      };

      await signOrder(sellParams);
      const [{ data: sellData }] = (signTypedData as any).mock.calls[1];
      expect(sellData.message.legs[0].isBuyingContract).toBe(false);
    });

    it('should set postOnly flag correctly', async () => {
      const mockSignature = '0xtest';
      (signTypedData as any).mockReturnValue(mockSignature);

      const orderParams = {
        instrument: 'ETH_USDT_Perp',
        side: 'buy' as const,
        quantity: 0.02,
        price: 2000.0,
        postOnly: true
      };

      await signOrder(orderParams);

      const [{ data }] = (signTypedData as any).mock.calls[0];
      expect(data.message.postOnly).toBe(true);
    });

    it('should generate unique nonce for each order', async () => {
      const mockSignature = '0xtest';
      (signTypedData as any).mockReturnValue(mockSignature);

      const orderParams = {
        instrument: 'ETH_USDT_Perp',
        side: 'buy' as const,
        quantity: 0.02,
        price: 2000.0,
        postOnly: true
      };

      await signOrder(orderParams);
      await signOrder(orderParams);

      const [{ data: data1 }] = (signTypedData as any).mock.calls[0];
      const [{ data: data2 }] = (signTypedData as any).mock.calls[1];

      expect(data1.message.nonce).not.toBe(data2.message.nonce);
      expect(typeof data1.message.nonce).toBe('number');
      expect(typeof data2.message.nonce).toBe('number');
    });

    it('should handle BTC_USDT_Perp correctly', async () => {
      const mockSignature = '0xtest';
      (signTypedData as any).mockReturnValue(mockSignature);

      const orderParams = {
        instrument: 'BTC_USDT_Perp',
        side: 'buy' as const,
        quantity: 0.001,
        price: 45000.0,
        postOnly: true
      };

      await signOrder(orderParams);

      const [{ data }] = (signTypedData as any).mock.calls[0];
      const orderLeg = data.message.legs[0];

      expect(orderLeg.assetID).toBe('0x030201'); // BTC_USDT_Perp asset ID
      expect(orderLeg.limitPrice).toBe('45000000000000'); // 45000 * 1e9
      expect(orderLeg.contractSize).toBe('1000000'); // 0.001 * 10^9
    });

    it('should use V4 signing version', async () => {
      const mockSignature = '0xtest';
      (signTypedData as any).mockReturnValue(mockSignature);

      const orderParams = {
        instrument: 'ETH_USDT_Perp',
        side: 'buy' as const,
        quantity: 0.02,
        price: 2000.0,
        postOnly: true
      };

      await signOrder(orderParams);

      const [signData] = (signTypedData as any).mock.calls[0];
      expect(signData.version).toBe(SignTypedDataVersion.V4);
    });

    it('should throw error for invalid instrument', async () => {
      const orderParams = {
        instrument: 'INVALID_INSTRUMENT',
        side: 'buy' as const,
        quantity: 0.02,
        price: 2000.0,
        postOnly: true
      };

      await expect(signOrder(orderParams)).rejects.toThrow();
    });

    it('should handle expiration timestamp correctly', async () => {
      const mockSignature = '0xtest';
      (signTypedData as any).mockReturnValue(mockSignature);

      const orderParams = {
        instrument: 'ETH_USDT_Perp',
        side: 'buy' as const,
        quantity: 0.02,
        price: 2000.0,
        postOnly: true
      };

      const beforeTime = Date.now();
      await signOrder(orderParams);
      const afterTime = Date.now();

      const [{ data }] = (signTypedData as any).mock.calls[0];
      const expiration = parseInt(data.message.expiration);

      // Expiration should be roughly current time + 24 hours (in seconds)
      const expectedMin = Math.floor((beforeTime + 24 * 60 * 60 * 1000) / 1000);
      const expectedMax = Math.floor((afterTime + 24 * 60 * 60 * 1000) / 1000);

      expect(expiration).toBeGreaterThanOrEqual(expectedMin);
      expect(expiration).toBeLessThanOrEqual(expectedMax);
    });
  });
});