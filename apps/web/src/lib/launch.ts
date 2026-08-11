/**
 * The one launch switch.
 *
 * Before launch the site must tell the truth: nothing has been sold, no revenue
 * exists, and payments are not open. With this flag set, `/access` renders the
 * real interface with every figure at zero and the payment controls visible but
 * veiled, so a visitor sees exactly what the product costs and how paying will
 * work without being able to pay early or read test-network activity as if it
 * were real.
 *
 * Launch day is deleting one line from `.env.site` and rebuilding.
 */
export const PRELAUNCH: boolean = process.env.NEXT_PUBLIC_PRELAUNCH === '1';
