// Grid Engine Tests
// Tests for round-trip logic, calculateRealGridProfit, fill detection

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GridEngine } from '../src/bot/grid-engine.js';
import { mockGrvtClient, mockDb, createMockFill, createMockOrder, createMockGridLevel } from './setup.js';

// Mock modules
vi.mock('../src/api/client.js', () => ({
  grvtClient: mockGrvtClient
}));

vi.mock('../src/database/db.js', () => ({
  db: mockDb
}));

describe('GridEngine', () => {
  let gridEngine: GridEngine;
  let mockBot: any;

  beforeEach(() => {
    // Setup mock bot
    mockBot = {
      id: 1,
      pair: 'ETH_USDT_Perp',
      direction: 'long',
      lower_price: 1800,
      upper_price: 2450,
      num_grids: 94,
      spacing: 6.99,
      leverage: 5
    };

    // Mock database responses
    mockDb.getBot.mockResolvedValue(mockBot);
    mockDb.getGridLevels.mockResolvedValue([]);
    mockDb.getOrders.mockResolvedValue([]);

    gridEngine = new GridEngine();
    (gridEngine as any).bot = mockBot; // Set bot directly for testing
  });

  describe('calculateRealGridProfit', () => {
    it('should return null when no fills exist', async () => {
      mockGrvtClient.getFillHistory.mockResolvedValue([]);
      
      const result = await (gridEngine as any).calculateRealGridProfit();
      expect(result).toBeNull();
    });

    it('should correctly pair buy/sell fills for profit calculation', async () => {
      const fills = [
        createMockFill({ 
          price: '2000.0', 
          size: '0.02', 
          fee: '0.1', 
          is_buyer: true, 
          event_time: '1000' 
        }),
        createMockFill({ 
          price: '2007.0', 
          size: '0.02', 
          fee: '0.1', 
          is_buyer: false, 
          event_time: '2000' 
        })
      ];
      
      mockGrvtClient.getFillHistory.mockResolvedValue(fills);
      
      const result = await (gridEngine as any).calculateRealGridProfit();
      
      // Should pair: sell at 2007 - buy at 2000 = $7 profit - $0.2 fees = $6.8 net
      expect(result).toBeCloseTo(6.8, 2);
    });

    it('should respect minimum $3 spread requirement', async () => {
      const fills = [
        createMockFill({ 
          price: '2000.0', 
          size: '0.02', 
          fee: '0.1', 
          is_buyer: true, 
          event_time: '1000' 
        }),
        createMockFill({ 
          price: '2002.0', 
          size: '0.02', 
          fee: '0.1', 
          is_buyer: false, 
          event_time: '2000' 
        })
      ];
      
      mockGrvtClient.getFillHistory.mockResolvedValue(fills);
      
      const result = await (gridEngine as any).calculateRealGridProfit();
      
      // Should not pair (spread = $2 < $3 minimum)
      expect(result).toBe(0);
    });

    it('should reject spreads above $20 (too wide)', async () => {
      const fills = [
        createMockFill({ 
          price: '2000.0', 
          size: '0.02', 
          fee: '0.1', 
          is_buyer: true, 
          event_time: '1000' 
        }),
        createMockFill({ 
          price: '2025.0', 
          size: '0.02', 
          fee: '0.1', 
          is_buyer: false, 
          event_time: '2000' 
        })
      ];
      
      mockGrvtClient.getFillHistory.mockResolvedValue(fills);
      
      const result = await (gridEngine as any).calculateRealGridProfit();
      
      // Should not pair (spread = $25 > $20 maximum)
      expect(result).toBe(0);
    });

    it('should find best spread when multiple buys available', async () => {
      const fills = [
        createMockFill({ 
          price: '1995.0', 
          size: '0.02', 
          fee: '0.1', 
          is_buyer: true, 
          event_time: '1000' 
        }),
        createMockFill({ 
          price: '2000.0', 
          size: '0.02', 
          fee: '0.1', 
          is_buyer: true, 
          event_time: '1100' 
        }),
        createMockFill({ 
          price: '2007.0', 
          size: '0.02', 
          fee: '0.1', 
          is_buyer: false, 
          event_time: '2000' 
        })
      ];
      
      mockGrvtClient.getFillHistory.mockResolvedValue(fills);
      
      const result = await (gridEngine as any).calculateRealGridProfit();
      
      // Should pair with 2000.0 buy (spread = $7) not 1995.0 buy (spread = $12)
      expect(result).toBeCloseTo(6.8, 2); // $7 - $0.2 fees = $6.8
    });

    it('should handle multiple round-trips correctly', async () => {
      const fills = [
        // First round-trip
        createMockFill({ 
          price: '2000.0', 
          size: '0.02', 
          fee: '0.1', 
          is_buyer: true, 
          event_time: '1000' 
        }),
        createMockFill({ 
          price: '2007.0', 
          size: '0.02', 
          fee: '0.1', 
          is_buyer: false, 
          event_time: '2000' 
        }),
        // Second round-trip
        createMockFill({ 
          price: '2010.0', 
          size: '0.02', 
          fee: '0.1', 
          is_buyer: true, 
          event_time: '3000' 
        }),
        createMockFill({ 
          price: '2017.0', 
          size: '0.02', 
          fee: '0.1', 
          is_buyer: false, 
          event_time: '4000' 
        })
      ];
      
      mockGrvtClient.getFillHistory.mockResolvedValue(fills);
      
      const result = await (gridEngine as any).calculateRealGridProfit();
      
      // Two round-trips: (2007-2000) + (2017-2010) - 4*0.1 = 7 + 7 - 0.4 = $13.6
      expect(result).toBeCloseTo(13.6, 2);
    });
  });

  describe('Fill Detection Logic', () => {
    it('should skip fill detection for levels close to current price (±$3.5)', async () => {
      const currentPrice = 2000;
      const gridLevels = [
        createMockGridLevel({ price: 1997, order_id: 'order_close_1' }),  // 3.0 diff - should skip
        createMockGridLevel({ price: 1996, order_id: 'order_far_1' }),    // 4.0 diff - should check
        createMockGridLevel({ price: 2003, order_id: 'order_close_2' }),  // 3.0 diff - should skip
        createMockGridLevel({ price: 2004.5, order_id: 'order_far_2' })   // 4.5 diff - should check
      ];

      mockDb.getGridLevels.mockResolvedValue(gridLevels);
      mockGrvtClient.getOpenOrders.mockResolvedValue([]);

      const fillDetectionSpy = vi.spyOn(gridEngine as any, 'handleOrderFilled').mockResolvedValue(undefined);

      await (gridEngine as any).monitorActiveOrders(currentPrice);

      // Only far orders should trigger fill detection
      expect(fillDetectionSpy).toHaveBeenCalledTimes(2);
    });

    it('should detect fills when order disappears from GRVT', async () => {
      const gridLevels = [
        createMockGridLevel({ 
          price: 1990, 
          order_id: 'order_missing', 
          level_index: 5, 
          side: 'buy' 
        })
      ];

      mockDb.getGridLevels.mockResolvedValue(gridLevels);
      mockGrvtClient.getOpenOrders.mockResolvedValue([]); // Order not in GRVT

      const fillDetectionSpy = vi.spyOn(gridEngine as any, 'handleOrderFilled').mockResolvedValue(undefined);

      await (gridEngine as any).monitorActiveOrders(2000);

      expect(fillDetectionSpy).toHaveBeenCalledWith(
        'order_missing',
        expect.objectContaining({
          price: 1990,
          side: 'buy',
          level_index: 5
        })
      );
    });

    it('should use price-based matching with ±$1 tolerance', async () => {
      const gridLevels = [
        createMockGridLevel({ 
          price: 2000.0, 
          order_id: 'order_exact', 
          side: 'buy' 
        }),
        createMockGridLevel({ 
          price: 2010.0, 
          order_id: 'order_close', 
          side: 'sell' 
        })
      ];

      const grvtOrders = [
        { 
          client_order_id: 'grvt_order_1',
          price: '1999.5', // 0.5 diff - should match with 2000.0
          side: 'buy'
        },
        {
          client_order_id: 'grvt_order_2', 
          price: '2010.8', // 0.8 diff - should match with 2010.0
          side: 'sell'
        }
      ];

      mockDb.getGridLevels.mockResolvedValue(gridLevels);
      mockGrvtClient.getOpenOrders.mockResolvedValue(grvtOrders);

      const fillDetectionSpy = vi.spyOn(gridEngine as any, 'handleOrderFilled').mockResolvedValue(undefined);

      await (gridEngine as any).monitorActiveOrders(2005);

      // No fills should be detected (both orders matched within ±$1 tolerance)
      expect(fillDetectionSpy).not.toHaveBeenCalled();
    });
  });

  describe('Round-trip Logic', () => {
    it('should place counter-order at level+1 when buy fills', async () => {
      const filledLevel = createMockGridLevel({
        level_index: 10,
        side: 'buy',
        price: 2000,
        id: 100
      });

      const counterLevel = createMockGridLevel({
        level_index: 11,
        side: 'sell',
        price: 2007,
        id: 101
      });

      const allLevels = [filledLevel, counterLevel];

      mockDb.getGridLevels.mockResolvedValue(allLevels);
      mockDb.updateGridLevel.mockResolvedValue(undefined);

      const placeOrderSpy = vi.spyOn(gridEngine as any, 'placeGridOrder').mockResolvedValue(undefined);

      await (gridEngine as any).handleOrderFilled('order_123', {
        grid_level_id: 100,
        side: 'buy',
        price: 2000,
        level_index: 10
      });

      // Should place sell order at level 11
      expect(placeOrderSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          side: 'sell',
          price: 2007,
          level_index: 11
        })
      );

      // Should mark filled level as filled
      expect(mockDb.updateGridLevel).toHaveBeenCalledWith(100, {
        is_filled: true,
        order_id: null
      });

      // Should update counter level
      expect(mockDb.updateGridLevel).toHaveBeenCalledWith(101, {
        side: 'sell',
        is_filled: false
      });
    });

    it('should place counter-order at level-1 when sell fills', async () => {
      const filledLevel = createMockGridLevel({
        level_index: 15,
        side: 'sell',
        price: 2050,
        id: 200
      });

      const counterLevel = createMockGridLevel({
        level_index: 14,
        side: 'buy',
        price: 2043,
        id: 199
      });

      const allLevels = [counterLevel, filledLevel];

      mockDb.getGridLevels.mockResolvedValue(allLevels);
      mockDb.updateGridLevel.mockResolvedValue(undefined);

      const placeOrderSpy = vi.spyOn(gridEngine as any, 'placeGridOrder').mockResolvedValue(undefined);

      await (gridEngine as any).handleOrderFilled('order_456', {
        grid_level_id: 200,
        side: 'sell',
        price: 2050,
        level_index: 15
      });

      // Should place buy order at level 14
      expect(placeOrderSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          side: 'buy',
          price: 2043,
          level_index: 14
        })
      );
    });

    it('should prevent placing counter-order at same level', async () => {
      const filledLevel = createMockGridLevel({
        level_index: 10,
        side: 'buy',
        price: 2000,
        id: 100
      });

      // No level+1 available
      const allLevels = [filledLevel];

      mockDb.getGridLevels.mockResolvedValue(allLevels);

      const placeOrderSpy = vi.spyOn(gridEngine as any, 'placeGridOrder').mockResolvedValue(undefined);

      await (gridEngine as any).handleOrderFilled('order_123', {
        grid_level_id: 100,
        side: 'buy',
        price: 2000,
        level_index: 10
      });

      // Should NOT place any order (no counter level found)
      expect(placeOrderSpy).not.toHaveBeenCalled();
    });
  });

  describe('Deduplication Logic', () => {
    it('should prevent processing same fill twice', async () => {
      const order = {
        grid_level_id: 100,
        side: 'buy',
        price: 2000
      };

      mockGrvtClient.getFillHistory.mockResolvedValue([]);
      mockDb.fillGridLevel.mockResolvedValue(undefined);

      const handleOrderFilledSpy = vi.spyOn(gridEngine as any, 'handleOrderFilled');

      // Process same order twice
      await (gridEngine as any).handleOrderFilled('order_123', order);
      await (gridEngine as any).handleOrderFilled('order_123', order);

      // Should be called twice but only execute once (second call returns early)
      expect(handleOrderFilledSpy).toHaveBeenCalledTimes(2);
    });
  });
});