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
  it('has entries for the local chain and Robinhood Chain', () => {
    expect(Object.keys(DEPLOYMENTS).sort()).toEqual(['31337', '4663']);
  });

  it('exposes exactly the nine contract fields on every entry', () => {
    for (const chainId of [31337, 4663]) {
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

  it('ships Robinhood Chain (4663) as undeployed until mainnet launch', () => {
    const deployment = DEPLOYMENTS[4663];
    for (const field of FIELDS) {
      expect(deployment?.[field], `4663.${field}`).toBe(ZERO);
    }
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
