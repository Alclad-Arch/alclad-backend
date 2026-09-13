/* Run async work one at a time, in the order it was asked for.
 *
 * Extracted from server.js's Salesforce service token on 2026-09-14, after two concurrent
 * refreshes killed the grant. The shape of that bug is general enough to be worth naming:
 *
 *   a cache check is synchronous, the work behind it is not — so between the miss and the fill,
 *   every concurrent caller also misses and also starts the work.
 *
 * Usually that is merely wasteful. It is DESTRUCTIVE when the work consumes something that can
 * only be used once: Salesforce rotates a refresh token on use and invalidates the old one, so the
 * second refresh either fails or invalidates the first one's result, and whichever store finishes
 * last wins. A token Salesforce has already killed then sits in the database looking perfectly
 * normal until the next refresh returns invalid_grant.
 *
 * A queue rather than a shared in-flight promise, deliberately. Sharing hands every caller the
 * same result, which is wrong for a caller that asked BECAUSE that result just failed — a 401 on a
 * cached access token needs a genuinely new token, not the one that 401'd. Queueing lets it wait
 * its turn and then do its own work, while still never overlapping.
 */
export function serialQueue() {
  let tail = Promise.resolve();
  return function run(fn) {
    const out = tail.then(fn);
    /* The queue must survive a rejection or one failure poisons every later task. Swallowed HERE,
       on the internal handle only — `out` still rejects for whoever queued it. */
    tail = out.then(() => {}, () => {});
    return out;
  };
}
