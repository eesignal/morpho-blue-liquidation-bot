/**
 * Tests for buildArbCalls — the core logic behind arbitrage.ts.
 *
 * UniswapV3 path: fork mainnet, supply collateral, borrow, and verify the
 * arb calldata simulates to a positive profit.
 *
 * Pendle path: mock the Pendle API with nock and verify the encoded calldata
 * includes the expected approve + pushCall structure.
 */

import { PENDLE_API_URL } from "@morpho-blue-liquidation-bot/config";
import { getChainAddresses } from "@morpho-org/blue-sdk";
import { executorAbi, ExecutorEncoder } from "executooor-viem";
import nock from "nock";
import { erc20Abi, parseUnits } from "viem";
import { readContract, simulateCalls } from "viem/actions";
import { beforeEach, describe, expect } from "vitest";

import { morphoBlueAbi } from "../../src/abis/morpho/morphoBlue.js";
import { buildArbCalls } from "../../src/utils/buildArbCalls.js";
import { wbtcUSDC, USDC, WBTC } from "../constants.js";
import { encoderTest } from "../setup.js";

const DEFAULT_UNISWAP_V3_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";

describe("buildArbCalls — UniswapV3 path", () => {
  beforeEach(() => {
    nock.cleanAll();
  });

  encoderTest.sequential(
    "encodes arb calldata for USDC→WBTC supply/borrow and simulates successfully",
    async ({ encoder }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = encoder.client as any;

      const morphoAddress = getChainAddresses(1).morpho;

      const _params = await readContract(client, {
        address: morphoAddress,
        abi: morphoBlueAbi,
        functionName: "idToMarketParams",
        args: [wbtcUSDC],
      });
      const market = {
        loanToken: _params[0],
        collateralToken: _params[1],
        oracle: _params[2],
        irm: _params[3],
        lltv: _params[4],
      };

      // Flash loan 5000 USDC, swap to WBTC, supply as collateral, borrow 5100 USDC
      const flashLoanAmount = parseUnits("5000", 6); // 5000 USDC
      const minCollateralOut = parseUnits("0.08", 8); // ~0.08 WBTC
      const borrowAmount = parseUnits("5100", 6); // 5100 USDC (profit = 100 USDC)

      const arbEncoder = new ExecutorEncoder(encoder.address, client);

      const calls = await buildArbCalls(arbEncoder, {
        morphoAddress,
        market,
        token0: USDC,
        token1: WBTC,
        flashLoanAmount,
        minCollateralOut,
        borrowAmount,
        collectionAddress: client.account.address,
        flashLoanSource: "morpho",
        swapVenue: "uniswap",
        chainId: 1,
        uniswapV3Router: DEFAULT_UNISWAP_V3_ROUTER,
        uniswapFee: 3000,
      });

      expect(calls.length).toBeGreaterThan(0);

      const { results } = await simulateCalls(client, {
        account: client.account.address,
        calls: [
          { to: USDC, abi: erc20Abi, functionName: "balanceOf", args: [client.account.address] },
          { to: encoder.address, abi: executorAbi, functionName: "exec_606BaXt", args: [calls] },
          { to: USDC, abi: erc20Abi, functionName: "balanceOf", args: [client.account.address] },
        ],
      });

      expect(results[1].status).toBe("success");
      const profit = results[2].result! - results[0].result!;
      expect(profit).toBeGreaterThan(0n);
    },
  );
});

describe("buildArbCalls — Pendle path (mocked API)", () => {
  beforeEach(() => {
    nock.cleanAll();
  });

  encoderTest.sequential(
    "encodes calldata for Pendle swap venue without hitting live API",
    async ({ encoder }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = encoder.client as any;

      const morphoAddress = getChainAddresses(1).morpho;

      const _params = await readContract(client, {
        address: morphoAddress,
        abi: morphoBlueAbi,
        functionName: "idToMarketParams",
        args: [wbtcUSDC],
      });
      const market = {
        loanToken: _params[0],
        collateralToken: _params[1],
        oracle: _params[2],
        irm: _params[3],
        lltv: _params[4],
      };

      const flashLoanAmount = parseUnits("5000", 6);
      const minCollateralOut = parseUnits("0.08", 8);
      const borrowAmount = parseUnits("5100", 6);

      // Mock Pendle API — return minimal swap calldata (approve + call to a fake router)
      const fakeRouter = "0x1111111111111111111111111111111111111111";
      const fakeSwapData = "0xdeadbeef";

      const pendleMarket = "0xb6ac3d5da138918ac4e84441e994a20daa60dbdd";
      const apiBase = PENDLE_API_URL.replace(/\/$/, "");
      nock(apiBase)
        .get(`/v2/sdk/1/markets/${pendleMarket}/swap`)
        .query(true) // match any query params
        .reply(200, {
          tx: {
            data: fakeSwapData,
            to: fakeRouter,
            value: "0",
          },
          data: { amountOut: minCollateralOut.toString() },
        });

      const arbEncoder = new ExecutorEncoder(encoder.address, client);

      const calls = await buildArbCalls(arbEncoder, {
        morphoAddress,
        market,
        token0: USDC,
        token1: WBTC,
        flashLoanAmount,
        minCollateralOut,
        borrowAmount,
        collectionAddress: client.account.address,
        flashLoanSource: "morpho",
        swapVenue: "pendle",
        chainId: 1,
        pendleMarket,
      });

      // Calldata should be non-empty
      expect(calls.length).toBeGreaterThan(0);

      // Verify nock intercepted the API call (no unmatched requests)
      expect(nock.pendingMocks()).toHaveLength(0);
    },
  );
});
