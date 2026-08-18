import { describe, expect, it } from 'vitest';
import { DEPLOYMENTS, getDeployment } from '../src/index';
import type { Deployment } from '../src/index';

const ZERO = '0x0000000000000000000000000000000000000000';

const FIELDS: readonly (keyof Deployment)[] = [
  'token',
  'priceSource',
  'revenueVault',
  'activation',
  'groupRegistry',
  'keyRegistry',
  'anchors',
  'perks',
  'handles',
];

describe('DEPLOYMENTS', () => {
  it('has entries for the local chain, Robinhood Chain and its testnet', () => {
    expect(Object.keys(DEPLOYMENTS).sort()).toEqual(['31337', '4663', '46630']);
  });

  it('exposes exactly the nine contract fields on every entry', () => {
    for (const chainId of [31337, 4663, 46630]) {
      const deployment = DEPLOYMENTS[chainId];
      expect(deployment).toBeDefined();
      expect(Object.keys(deployment ?? {}).sort()).toEqual([...FIELDS].sort());
    }
  });

  // deployments.ts is a GENERATED file: infra/scripts/deploy-local.mjs rewrites the 31337 entry with
  // real addresses. Asserting those are still zero fails for every developer who has run a local
  // deploy, so assert the SHAPE instead — each field present and a well-formed 20-byte address,
  // whether that is the zero sentinel (undeployed) or a live one.
  it('exposes a well-formed address for every field on every chain', () => {
    for (const chainId of [31337, 4663]) {
      const deployment = DEPLOYMENTS[chainId];
      expect(deployment, `chain ${chainId} must be present`).toBeDefined();
      for (const field of FIELDS) {
        expect(deployment?.[field], `${chainId}.${field}`).toMatch(/^0x[0-9a-fA-F]{40}$/);
      }
    }
  });

  // Deployed 2026-08-18 from block 39819111, wired to the external test token. On launch day the
  // `token` field changes to the real $GRAM (setToken on chain, then this file); the other eight
  // addresses are permanent and pinned exactly so a half-swapped edit fails loudly here.
  it('pins the live Robinhood Chain (4663) deployment', () => {
    const deployment = DEPLOYMENTS[4663];
    expect(deployment?.priceSource).toBe('0xAA164D5E19F2EeEca56aF3CBBe677533e962f109');
    expect(deployment?.revenueVault).toBe('0x168946858dB2890022d598C328a4235b2aaE32d5');
    expect(deployment?.activation).toBe('0x063c91F8311b7183B3EEC8099Ee7961c11Dbdc14');
    expect(deployment?.groupRegistry).toBe('0x20695Cb87aff1263C4FF60D6e783bd19B465498a');
    expect(deployment?.keyRegistry).toBe('0x70cF5a2Fcc2869d39B803dBc23907b19f7F6d3Fc');
    expect(deployment?.anchors).toBe('0x69eD2E0f5257A90cb88920B0E4Fa4C7792428237');
    expect(deployment?.perks).toBe('0xadAf0D8E2c07dBE120961dadA9f5D1B5f53C6bB9');
    expect(deployment?.handles).toBe('0xc1A4a50aaF556d08b7D4EB36265Ab1Bd6f44E934');
    // The token is live too — never the zero sentinel again — but deliberately not pinned to one
    // address: it is the single field that changes on launch day.
    expect(deployment?.token).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(deployment?.token).not.toBe(ZERO);
  });

  it('gives each chain its own object', () => {
    expect(DEPLOYMENTS[31337]).not.toBe(DEPLOYMENTS[4663]);
  });
});

describe('getDeployment', () => {
  it('returns the local anvil deployment', () => {
    expect(getDeployment(31337)).toBe(DEPLOYMENTS[31337]);
  });

  it('returns the Robinhood Chain deployment', () => {
    expect(getDeployment(4663)).toBe(DEPLOYMENTS[4663]);
  });

  it('throws a clear error naming the unknown chain', () => {
    expect(() => getDeployment(1)).toThrow(/no deployment for chainId 1/i);
  });

  it('lists the known chains in the error', () => {
    expect(() => getDeployment(8453)).toThrow(/31337/);
    expect(() => getDeployment(8453)).toThrow(/4663/);
  });

  it('throws for nonsensical chain ids rather than returning undefined', () => {
    expect(() => getDeployment(-1)).toThrow(/no deployment/i);
    expect(() => getDeployment(0)).toThrow(/no deployment/i);
    expect(() => getDeployment(Number.NaN)).toThrow(/no deployment/i);
  });

  it('does not resolve inherited object properties', () => {
    expect(() => getDeployment('toString' as unknown as number)).toThrow(/no deployment/i);
  });
});
