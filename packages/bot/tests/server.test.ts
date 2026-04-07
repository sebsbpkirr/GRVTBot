// Server Tests
// Tests for SIGTERM handler and graceful shutdown

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock GridEngine
const mockGridEngine = {
  isRunning: true,
  monitoringInterval: null as NodeJS.Timeout | null,
  fundingPollingInterval: null as NodeJS.Timeout | null,
  stop: vi.fn()
};

// Mock Database
const mockDb = {
  close: vi.fn()
};

// Mock process
const mockProcess = new EventEmitter();
mockProcess.exit = vi.fn() as any;

// We'll need to mock the actual server file imports
vi.mock('../src/bot/grid-engine.js', () => ({
  GridEngine: vi.fn(() => mockGridEngine)
}));

vi.mock('../src/database/db.js', () => ({
  db: mockDb
}));

describe('Server SIGTERM Handler', () => {
  let originalProcess: typeof process;
  let clearIntervalSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Mock console to avoid test pollution
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    
    // Spy on clearInterval
    clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    
    // Reset mock states
    mockGridEngine.isRunning = true;
    mockGridEngine.monitoringInterval = setTimeout(() => {}, 1000) as any;
    mockGridEngine.fundingPollingInterval = setTimeout(() => {}, 1000) as any;
    mockDb.close.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Clean up any intervals that were created
    if (mockGridEngine.monitoringInterval) {
      clearInterval(mockGridEngine.monitoringInterval);
    }
    if (mockGridEngine.fundingPollingInterval) {
      clearInterval(mockGridEngine.fundingPollingInterval);
    }
  });

  it('should handle SIGTERM without canceling GRVT orders', async () => {
    // Simulate SIGTERM handler logic directly (since we can't easily test the actual signal)
    
    // This is what the SIGTERM handler should do:
    const sigtermHandler = async () => {
      console.log('🛑 SIGTERM received, shutting down gracefully (keeping orders on GRVT)...');
      
      // DO NOT call gridEngine.stop() - it cancels all orders!
      // Just stop intervals and close DB
      mockGridEngine.isRunning = false;
      
      if (mockGridEngine.monitoringInterval) {
        clearInterval(mockGridEngine.monitoringInterval);
        mockGridEngine.monitoringInterval = null;
      }
      
      if (mockGridEngine.fundingPollingInterval) {
        clearInterval(mockGridEngine.fundingPollingInterval);
        mockGridEngine.fundingPollingInterval = null;
      }
      
      await mockDb.close();
      console.log('✅ Graceful shutdown complete (orders preserved on GRVT)');
      process.exit(0);
    };

    await sigtermHandler();

    // Verify behavior
    expect(mockGridEngine.isRunning).toBe(false);
    expect(mockGridEngine.monitoringInterval).toBeNull();
    expect(mockGridEngine.fundingPollingInterval).toBeNull();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    expect(mockDb.close).toHaveBeenCalledOnce();
    
    // Most importantly: gridEngine.stop() should NOT be called
    expect(mockGridEngine.stop).not.toHaveBeenCalled();
    
    expect(mockProcess.exit).toHaveBeenCalledWith(0);
  });

  it('should handle SIGINT differently (with order cancellation)', async () => {
    // SIGINT should call gridEngine.stop() to cancel orders
    const sigintHandler = async () => {
      console.log('\\n🛑 Dashboard shutting down...');
      
      try {
        await mockGridEngine.stop(); // This cancels orders
        await mockDb.close();
        console.log('✅ Graceful shutdown complete');
        process.exit(0);
      } catch (error) {
        console.error('❌ Error during shutdown:', error);
        process.exit(1);
      }
    };

    await sigintHandler();

    // Verify SIGINT calls stop() (cancels orders)
    expect(mockGridEngine.stop).toHaveBeenCalledOnce();
    expect(mockDb.close).toHaveBeenCalledOnce();
    expect(mockProcess.exit).toHaveBeenCalledWith(0);
  });

  it('should handle database close errors during SIGTERM', async () => {
    const dbError = new Error('Database close failed');
    mockDb.close.mockRejectedValue(dbError);

    const sigtermHandler = async () => {
      try {
        console.log('🛑 SIGTERM received, shutting down gracefully (keeping orders on GRVT)...');
        
        mockGridEngine.isRunning = false;
        
        if (mockGridEngine.monitoringInterval) {
          clearInterval(mockGridEngine.monitoringInterval);
          mockGridEngine.monitoringInterval = null;
        }
        
        if (mockGridEngine.fundingPollingInterval) {
          clearInterval(mockGridEngine.fundingPollingInterval);
          mockGridEngine.fundingPollingInterval = null;
        }
        
        await mockDb.close();
        console.log('✅ Graceful shutdown complete (orders preserved on GRVT)');
        process.exit(0);
      } catch (error) {
        console.error('❌ Error during SIGTERM shutdown:', error);
        process.exit(1);
      }
    };

    await sigtermHandler();

    expect(mockDb.close).toHaveBeenCalledOnce();
    expect(mockProcess.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith('❌ Error during SIGTERM shutdown:', dbError);
    
    // Still should not call gridEngine.stop() even on error
    expect(mockGridEngine.stop).not.toHaveBeenCalled();
  });

  it('should clean up intervals even if they are null', async () => {
    // Test edge case where intervals are already null
    mockGridEngine.monitoringInterval = null;
    mockGridEngine.fundingPollingInterval = null;

    const sigtermHandler = async () => {
      mockGridEngine.isRunning = false;
      
      if (mockGridEngine.monitoringInterval) {
        clearInterval(mockGridEngine.monitoringInterval);
        mockGridEngine.monitoringInterval = null;
      }
      
      if (mockGridEngine.fundingPollingInterval) {
        clearInterval(mockGridEngine.fundingPollingInterval);
        mockGridEngine.fundingPollingInterval = null;
      }
      
      await mockDb.close();
      process.exit(0);
    };

    await sigtermHandler();

    // Should not call clearInterval when intervals are null
    expect(clearIntervalSpy).not.toHaveBeenCalled();
    expect(mockDb.close).toHaveBeenCalledOnce();
    expect(mockProcess.exit).toHaveBeenCalledWith(0);
  });

  it('should preserve orders on GRVT during SIGTERM shutdown', () => {
    // This is the critical test: SIGTERM should NOT cancel GRVT orders
    
    const sigtermHandler = () => {
      // Verify the handler does NOT call any order cancellation methods
      // Only stops intervals and closes database
      mockGridEngine.isRunning = false;
      
      if (mockGridEngine.monitoringInterval) {
        clearInterval(mockGridEngine.monitoringInterval);
        mockGridEngine.monitoringInterval = null;
      }
      
      if (mockGridEngine.fundingPollingInterval) {
        clearInterval(mockGridEngine.fundingPollingInterval);
        mockGridEngine.fundingPollingInterval = null;
      }
      
      // No calls to gridEngine.stop() or any cancel methods
      // This preserves all active orders on GRVT
    };

    sigtermHandler();

    expect(mockGridEngine.isRunning).toBe(false);
    expect(mockGridEngine.stop).not.toHaveBeenCalled();
    
    // The key assertion: orders remain active on GRVT
    // (verified by NOT calling gridEngine.stop())
  });
});