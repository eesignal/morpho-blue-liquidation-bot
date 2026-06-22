import { Erc4626, UniswapV3Venue } from "@morpho-blue-liquidation-bot/liquidity-venues";
import { executorAbi } from "executooor-viem";
import { erc20Abi, parseUnits } from "viem";
import { readContract, simulateCalls } from "viem/actions";
import { describe, expect } from "vitest";

import { morphoBlueAbi } from "../../src/abis/morpho/morphoBlue.js";
import { buildLiquidateCalls } from "../../src/utils/buildLiquidateCalls.js";
import { LiquidationEncoder } from "../../src/utils/LiquidationEncoder.js";
import { borrower, MORPHO, wbtcUSDC } from "../constants.js";
import { getPositionCollateral, setupPosition, syncTimestamp } from "../helpers.js";
import { encoderTest } from "../setup.js";

describe("buildLiquidateCalls — WBTC/USDC market", () => {
  const erc4626 = new Erc4626();
  const uniswapV3 = new UniswapV3Venue();

  encoderTest.sequential("liquidates an underwater WBTC/USDC position", async ({ encoder }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = encoder.client as any;

    const collateralAmount = parseUnits("0.1", 8); // 0.1 WBTC
    const borrowAmount = parseUnits("5000", 6); // 5000 USDC

    const _params = await readContract(client, {
      address: MORPHO,
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

    await setupPosition(client, market, collateralAmount, borrowAmount);
    await syncTimestamp(client);

    const collateral = await getPositionCollateral(client, wbtcUSDC, borrower.address);
    expect(collateral).toBeGreaterThan(0n);

    const liquidationEncoder = new LiquidationEncoder(encoder.address, client);

    const calls = await buildLiquidateCalls(liquidationEncoder, {
      morphoAddress: MORPHO,
      market,
      borrower: borrower.address,
      seizedAssets: collateral,
      liquidityVenues: [erc4626, uniswapV3],
      treasuryAddress: client.account.address,
    });

    expect(calls).not.toBeNull();

    const { results } = await simulateCalls(client, {
      account: client.account.address,
      calls: [
        {
          to: market.loanToken,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [client.account.address],
        },
        { to: encoder.address, abi: executorAbi, functionName: "exec_606BaXt", args: [calls!] },
        {
          to: market.loanToken,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [client.account.address],
        },
      ],
    });

    expect(results[1].status).toBe("success");
    const profit = results[2].result! - results[0].result!;
    expect(profit).toBeGreaterThan(0n);
  });

  encoderTest.sequential("returns null when no venue supports the route", async ({ encoder }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = encoder.client as any;

    const collateralAmount = parseUnits("0.1", 8);
    const borrowAmount = parseUnits("5000", 6);

    const _params = await readContract(client, {
      address: MORPHO,
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

    await setupPosition(client, market, collateralAmount, borrowAmount);

    const liquidationEncoder = new LiquidationEncoder(encoder.address, client);

    // Pass empty venues — should return null
    const calls = await buildLiquidateCalls(liquidationEncoder, {
      morphoAddress: MORPHO,
      market,
      borrower: borrower.address,
      seizedAssets: collateralAmount / 2n,
      liquidityVenues: [],
      treasuryAddress: client.account.address,
    });

    expect(calls).toBeNull();
  });
});
