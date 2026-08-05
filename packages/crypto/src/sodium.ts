/**
 * Internal libsodium loader for `@telehood/crypto`.
 *
 * `libsodium-wrappers-sumo` compiles to WebAssembly/asm.js and is only usable once its
 * `ready` promise has settled. Every async export in this package awaits {@link ready}
 * first, so callers never have to think about initialisation order.
 *
 * This module is intentionally NOT part of the public barrel — it is an implementation
 * detail of the package.
 */
import type * as SodiumNamespace from 'libsodium-wrappers-sumo';

/** The initialised libsodium API surface. */
export type Sodium = typeof SodiumNamespace;

const PACKAGE_NAME = 'libsodium-wrappers-sumo';

/** Memoised, initialised sodium instance. Reset to `null` if loading failed. */
let pending: Promise<Sodium> | null = null;

function isSodiumInstance(value: unknown): value is Sodium {
  return typeof value === 'object' && value !== null && 'ready' in value;
}

/**
 * Normalises the various shapes a module can take (ESM namespace, CJS interop object,
 * bare CJS exports) down to the sodium instance itself.
 */
function unwrapModule(mod: unknown): Sodium {
  if (typeof mod === 'object' && mod !== null && 'default' in mod) {
    const inner: unknown = (mod as { default: unknown }).default;
    if (isSodiumInstance(inner)) {
      return inner;
    }
  }
  if (isSodiumInstance(mod)) {
    return mod;
  }
  throw new Error(`${PACKAGE_NAME} did not expose a libsodium instance`);
}

function isNodeRuntime(): boolean {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return typeof proc?.versions?.node === 'string';
}

/**
 * Node-only fallback.
 *
 * `libsodium-wrappers-sumo@0.7.16` ships a broken ESM bundle: its `.mjs` entry point
 * does `import "./libsodium-sumo.mjs"`, a sibling file that is not published. The CJS
 * build is intact, so under Node we load that instead. Kept behind a runtime check and
 * a non-literal specifier so bundlers targeting the browser never pull in `node:module`.
 */
async function loadViaNodeRequire(): Promise<Sodium> {
  const nodeModuleSpecifier: string = 'node:module';
  const nodeModule = (await import(nodeModuleSpecifier)) as {
    createRequire(path: string): (id: string) => unknown;
  };
  const requireFn = nodeModule.createRequire(import.meta.url);
  return unwrapModule(requireFn(PACKAGE_NAME));
}

async function load(): Promise<Sodium> {
  let esmFailure: unknown;
  try {
    return unwrapModule(await import('libsodium-wrappers-sumo'));
  } catch (err: unknown) {
    esmFailure = err;
  }

  if (isNodeRuntime()) {
    try {
      return await loadViaNodeRequire();
    } catch (err: unknown) {
      throw new Error(
        `@telehood/crypto could not load ${PACKAGE_NAME} (neither the ESM nor the CommonJS entry point resolved).`,
        { cause: err },
      );
    }
  }

  throw new Error(`@telehood/crypto could not load ${PACKAGE_NAME}.`, { cause: esmFailure });
}

/**
 * Resolves to a fully initialised libsodium instance.
 *
 * The instance is loaded once and memoised. A failed load is not cached, so a transient
 * problem does not permanently poison the module.
 */
export function ready(): Promise<Sodium> {
  if (pending === null) {
    pending = load()
      .then(async (sodium: Sodium): Promise<Sodium> => {
        await sodium.ready;
        return sodium;
      })
      .catch((err: unknown): never => {
        pending = null;
        throw err;
      });
  }
  return pending;
}
