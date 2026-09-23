/**
 * Points earned across a run of balances: the sum of its rises.
 *
 * A fall is spending -- a redeemed reward or a lost bet -- and is left
 * out, so a day of heavy spending reads as a day of earning, not as a hole.
 * `prior` is the balance in force before the run began; with none, the
 * first balance is only where counting starts.
 */
export function earnedFor(prior: number | null, balances: readonly number[]): number {
  let earned = 0;
  let last = prior;
  for (const balance of balances) {
    if (last !== null && balance > last) earned += balance - last;
    last = balance;
  }
  return earned;
}
